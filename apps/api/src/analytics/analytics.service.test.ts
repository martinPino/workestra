import { describe, it, expect, beforeEach } from 'vitest';
import { ANALYTICS_SCHEMA_VERSION, type AnalyticsSink, type StoredAnalyticsEvent } from '@core/contracts';
import { AnalyticsService, analyticsEnabled } from './analytics.service';
import { PlatformAdminService, parseAllowlist } from './platform-admin';

/** Sumidero de juguete que se queda con lo escrito para poder mirarlo. */
function fakeSink() {
  const rows: StoredAnalyticsEvent[] = [];
  const sink: AnalyticsSink = {
    async ingest(r) {
      rows.push(...r);
      return { accepted: r.length, dropped: 0 };
    },
    async topSurfaces() { return []; },
    async tabDwell() { return []; },
    async topEntities() { return []; },
    async activeUsers() { return []; },
    async retention() { return []; },
    async errors() { return []; },
    async searchQuality() { return []; },
    async sessions() { return { sessions: 0, users: 0, medianDurationMs: null, eventsPerSession: 0 }; },
    async featureUsage() { return []; },
    async funnel() { return []; },
  };
  return { rows, sink };
}

const svc = (sink: AnalyticsSink) => new AnalyticsService(sink, {} as never);

const ev = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  at: new Date().toISOString(),
  sessionId: '22222222-2222-4222-8222-222222222222',
  seq: 1,
  name: 'page.viewed',
  surface: '/workflows',
  props: {},
  ...over,
});

const batch = (...events: unknown[]) => ({ v: ANALYTICS_SCHEMA_VERSION as 1, events: events as never });

// La analítica está APAGADA por defecto (ver `analyticsEnabled`), así que los tests de ingesta la encienden
// a propósito. Que haya que hacerlo es justamente la garantía que queremos.
beforeEach(() => {
  process.env.ANALYTICS_ENABLED = 'true';
});

describe('Ingesta de analítica — atribución y aislamiento', () => {
  it('el workspace y el usuario SIEMPRE salen de la sesión, nunca del cuerpo', async () => {
    // Si el cliente pudiera elegirlos, cualquiera escribiría en la analítica de otro cliente.
    const { rows, sink } = fakeSink();
    await svc(sink).ingest(batch(ev()), 'ws_real', 'user_real');
    expect(rows[0].workspaceId).toBe('ws_real');
    expect(rows[0].userId).toBe('user_real');
  });

  it('un evento que INTENTA traer workspaceId se descarta entero', async () => {
    const { rows, sink } = fakeSink();
    const res = await svc(sink).ingest(batch(ev({ workspaceId: 'ws_ajeno' })), 'ws_real', 'u');
    expect(res.accepted).toBe(0);
    expect(res.dropped).toBe(1);
    expect(rows).toHaveLength(0);
  });

  it('un evento inválido NO tumba el resto del lote', async () => {
    // Devolver 400 por uno malo haría que el cliente reintentase el mismo lote envenenado para siempre.
    const { rows, sink } = fakeSink();
    const res = await svc(sink).ingest(batch(ev(), ev({ name: 'inventado' }), ev({ seq: 2 })), 'ws', 'u');
    expect(res.accepted).toBe(2);
    expect(res.dropped).toBe(1);
    expect(rows).toHaveLength(2);
  });
});

describe('Ingesta — el reloj del cliente no es de fiar', () => {
  it('una hora razonable se respeta', async () => {
    const { rows, sink } = fakeSink();
    const hace1h = new Date(Date.now() - 3_600_000).toISOString();
    await svc(sink).ingest(batch(ev({ at: hace1h })), 'ws', 'u');
    expect(rows[0].at).toBe(hace1h);
  });

  it('una hora absurda se acota a la de recepción (un reloj torcido falsearía el DAU de todos)', async () => {
    const { rows, sink } = fakeSink();
    const año2000 = '2000-01-01T00:00:00.000Z';
    await svc(sink).ingest(batch(ev({ at: año2000 })), 'ws', 'u');
    expect(rows[0].at).not.toBe(año2000);
    expect(Math.abs(Date.parse(rows[0].at) - Date.now())).toBeLessThan(5_000);
  });

  it('una hora en el futuro también se acota', async () => {
    const { rows, sink } = fakeSink();
    await svc(sink).ingest(batch(ev({ at: new Date(Date.now() + 5 * 86_400_000).toISOString() })), 'ws', 'u');
    expect(Math.abs(Date.parse(rows[0].at) - Date.now())).toBeLessThan(5_000);
  });
});

describe('Ingesta — barreras', () => {
  it('descarta un evento cuyas props parezcan llevar una credencial', async () => {
    // El esquema ya lo impide; esto es la segunda barrera, y que salte significa que hay un fallo arriba.
    const { rows, sink } = fakeSink();
    const res = await svc(sink).ingest(
      batch(ev({ name: 'custom', props: { key: 'x', value: 'af_jKHjaunXPtfsAdZkmvq71P4vgF0IoIpG' } })),
      'ws',
      'u',
    );
    expect(res.accepted).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it('corta a un cliente que se desboca, sin afectar a otro workspace', async () => {
    const { sink } = fakeSink();
    const s = svc(sink);
    const lote = batch(...Array.from({ length: 50 }, (_, i) => ev({ seq: i })));
    let aceptados = 0;
    for (let i = 0; i < 200; i++) aceptados += (await s.ingest(lote, 'ws_ruidoso', 'u')).accepted;
    expect(aceptados).toBeLessThanOrEqual(6_000);
    // El vecino sigue entrando con normalidad: el tope es por workspace, no global.
    expect((await s.ingest(batch(ev()), 'ws_tranquilo', 'u')).accepted).toBe(1);
  });
});

describe('Administrador de plataforma — un correo no es una identidad', () => {
  /** Bundle de juguete con solo las cuentas que existen. */
  const withAccounts = (emails: Record<string, string>) =>
    ({ auth: { async findByEmail(e: string) { return emails[e] ? { id: emails[e], email: e } : null; } } }) as never;

  const boot = async (envValue: string | undefined, accounts: Record<string, string>) => {
    if (envValue === undefined) delete process.env.ANALYTICS_ADMIN_EMAILS;
    else process.env.ANALYTICS_ADMIN_EMAILS = envValue;
    const svc = new PlatformAdminService(withAccounts(accounts));
    await svc.onModuleInit();
    return svc;
  };

  beforeEach(() => {
    delete process.env.ANALYTICS_ADMIN_EMAILS;
  });

  it('sin la variable configurada NO hay administradores (ni siquiera el dueño)', async () => {
    const svc = await boot(undefined, { 'yo@empresa.com': 'u1' });
    expect(svc.isAdmin('u1')).toBe(false);
  });

  it('una lista vacía no concede acceso a nadie', async () => {
    const svc = await boot('   ', { 'yo@empresa.com': 'u1' });
    expect(svc.isAdmin('u1')).toBe(false);
  });

  it('concede por ID de la cuenta que YA existía, no por el correo', async () => {
    const svc = await boot(' Yo@Empresa.com , otro@empresa.com ', { 'yo@empresa.com': 'u1', 'otro@empresa.com': 'u2' });
    expect(svc.isAdmin('u1')).toBe(true);
    expect(svc.isAdmin('u2')).toBe(true);
    expect(svc.isAdmin('u3')).toBe(false);
    expect(svc.isAdmin(undefined)).toBe(false);
  });

  it('un correo de la lista SIN cuenta no concede nada: registrarse con él después no sirve', async () => {
    // Era la vía real: si `admin@…` está en la lista y nadie la ha registrado, quien se registre con esa
    // dirección se llevaría los datos de todos los clientes. Al resolver a ids al arrancar, no.
    const svc = await boot('admin@empresa.com', {});
    expect(svc.isAdmin('el-que-se-registro-luego')).toBe(false);
  });

  it('si la resolución falla, el permiso NO se concede', async () => {
    process.env.ANALYTICS_ADMIN_EMAILS = 'yo@empresa.com';
    const roto = { auth: { async findByEmail() { throw new Error('BD caída'); } } } as never;
    const svc = new PlatformAdminService(roto);
    await svc.onModuleInit();
    expect(svc.isAdmin('u1')).toBe(false);
  });

  it('parseAllowlist normaliza espacios y mayúsculas', () => {
    expect(parseAllowlist(' A@b.com ,, C@D.com ')).toEqual(['a@b.com', 'c@d.com']);
    expect(parseAllowlist(undefined)).toEqual([]);
  });
});

describe('Interruptor general — apagado por defecto', () => {
  beforeEach(() => {
    delete process.env.ANALYTICS_ENABLED;
  });

  it('sin la variable NO se recoge nada: recoger navegación de personas se enciende a propósito', () => {
    expect(analyticsEnabled()).toBe(false);
  });

  it('solo el valor exacto «true» enciende (nada de «1», «yes» o vacío)', () => {
    for (const v of ['1', 'yes', 'on', '', ' ', 'false', 'TRUE ']) {
      process.env.ANALYTICS_ENABLED = v;
      expect(analyticsEnabled()).toBe(v.trim().toLowerCase() === 'true');
    }
  });

  it('apagado, la ingesta descarta TODO aunque el lote sea válido', async () => {
    // Una pestaña abierta desde antes de apagarlo seguiría mandando: no puede seguir escribiendo.
    delete process.env.ANALYTICS_ENABLED;
    const { rows, sink } = fakeSink();
    const res = await svc(sink).ingest(batch(ev(), ev({ seq: 2 })), 'ws', 'u');
    expect(res.accepted).toBe(0);
    expect(res.dropped).toBe(2);
    expect(rows).toHaveLength(0);
  });

  it('encendido vuelve a aceptar, sin reiniciar nada del servicio', async () => {
    process.env.ANALYTICS_ENABLED = 'true';
    const { rows, sink } = fakeSink();
    expect((await svc(sink).ingest(batch(ev()), 'ws', 'u')).accepted).toBe(1);
    expect(rows).toHaveLength(1);
  });
});
