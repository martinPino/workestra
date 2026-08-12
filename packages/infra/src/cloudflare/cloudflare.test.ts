import { describe, it, expect } from 'vitest';
import { emptyContext } from '@core/contracts';
import type { ExecutionEvent } from '@core/contracts';
import { R2FileStore } from './r2-file-store';
import { DurableObjectContextStore, DurableObjectEventPublisher } from './execution-room';
import { DurableObjectWorkspaceUsageRepository } from './workspace-usage';
import { FakeR2Bucket, FakeDurableObjectNamespace } from './fakes';

describe('R2FileStore (M48 sobre R2)', () => {
  it('guarda y recupera un fichero conservando nombre y mimeType', async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2FileStore(bucket);
    const bytes = new TextEncoder().encode('factura');

    const ref = await store.put('ws_1', { name: 'factura.pdf', mimeType: 'application/pdf', bytes });
    expect(ref.size).toBe(bytes.byteLength);

    const got = await store.get('ws_1', ref.id);
    expect(got).not.toBeNull();
    expect(got!.name).toBe('factura.pdf');
    expect(got!.mimeType).toBe('application/pdf');
    expect(new TextDecoder().decode(got!.bytes)).toBe('factura');
  });

  it('aísla por tenant: otro workspace no ve el fichero aunque acierte el id', async () => {
    const store = new R2FileStore(new FakeR2Bucket());
    const ref = await store.put('ws_1', { name: 'x.txt', mimeType: 'text/plain', bytes: new Uint8Array([1]) });
    expect(await store.get('ws_2', ref.id)).toBeNull();
  });

  it('sube solo el rango de la vista, no el buffer subyacente', async () => {
    // Un Uint8Array troceado comparte el buffer con el original: si el adaptador pasara `.buffer`,
    // subiría los 8 bytes en vez de los 3 del trozo.
    const bucket = new FakeR2Bucket();
    const store = new R2FileStore(bucket);
    const slice = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).subarray(2, 5);

    const ref = await store.put('ws_1', { name: 'trozo.bin', mimeType: 'application/octet-stream', bytes: slice });
    expect(ref.size).toBe(3);
    const got = await store.get('ws_1', ref.id);
    expect(Array.from(got!.bytes)).toEqual([3, 4, 5]);
  });

  it('devuelve null para un fichero caducado por la lifecycle rule', async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2FileStore(bucket);
    const ref = await store.put('ws_1', { name: 'efimero.txt', mimeType: 'text/plain', bytes: new Uint8Array([9]) });
    // La caducidad de R2 borra el objeto: para el adaptador es indistinguible de «no existe».
    bucket.objects.clear();
    expect(await store.get('ws_1', ref.id)).toBeNull();
  });
});

/** DO de ejecución falso: guarda el contexto y acumula los eventos difundidos. */
function executionRoomNs() {
  return new FakeDurableObjectNamespace((state, req) => {
    if (req.path === '/context' && req.method === 'GET') {
      const ctx = state.get('ctx');
      return ctx === undefined ? { status: 404 } : { status: 200, body: ctx };
    }
    if (req.path === '/context' && req.method === 'POST') {
      state.set('ctx', req.body);
      return { status: 204 };
    }
    if (req.path === '/events' && req.method === 'POST') {
      const seen = (state.get('events') as unknown[]) ?? [];
      seen.push(req.body);
      state.set('events', seen);
      return { status: 204 };
    }
    return { status: 404 };
  });
}

describe('DurableObjectContextStore', () => {
  it('devuelve un contexto vacío cuando la ejecución aún no ha checkpointeado', async () => {
    // El 404 del DO es el caso normal del primer nodo, no un error: tratarlo como fallo rompería
    // toda ejecución nueva.
    const store = new DurableObjectContextStore(executionRoomNs());
    expect(await store.load('exec_1')).toEqual(emptyContext());
  });

  it('hace ida y vuelta del contexto y aísla por ejecución', async () => {
    const ns = executionRoomNs();
    const store = new DurableObjectContextStore(ns);
    const ctx = { ...emptyContext(), variables: { 'code:paso': { ok: true } } };

    await store.checkpoint('exec_1', ctx);
    expect(await store.load('exec_1')).toEqual(ctx);
    // Otra ejecución es otro objeto: no ve el checkpoint del primero.
    expect(await store.load('exec_2')).toEqual(emptyContext());
  });

  it('lanza si el checkpoint no se guarda', async () => {
    // Un checkpoint perdido haría que la reanudación arrancara con contexto viejo y repitiera efectos.
    const ns = new FakeDurableObjectNamespace(() => ({ status: 500 }));
    const store = new DurableObjectContextStore(ns);
    await expect(store.checkpoint('exec_1', emptyContext())).rejects.toThrow(/500/);
  });
});

describe('DurableObjectEventPublisher', () => {
  it('difunde el evento al DO de SU ejecución', async () => {
    const ns = executionRoomNs();
    const publisher = new DurableObjectEventPublisher(ns);
    const event = { type: 'node.started', executionId: 'exec_1', nodeKey: 'paso', seq: 0 } as unknown as ExecutionEvent;

    await publisher.publish(event);

    expect(ns.instances.get('exec:exec_1')?.get('events')).toEqual([event]);
    expect(ns.instances.has('exec:exec_2')).toBe(false);
  });
});

describe('DurableObjectWorkspaceUsageRepository (M33 sobre DO)', () => {
  /** DO de uso falso: contador por día, como el que sirve en producción. */
  const usageNs = () =>
    new FakeDurableObjectNamespace((state, req) => {
      if (req.path === '/add') {
        const { tokens, day } = req.body as { tokens: number; day: string };
        const total = ((state.get(day) as number) ?? 0) + tokens;
        state.set(day, total);
        return { status: 200, body: { total } };
      }
      if (req.path === '/today') {
        return { status: 200, body: { total: (state.get(req.search.get('day')!) as number) ?? 0 } };
      }
      return { status: 404 };
    });

  it('acumula tokens del día y aísla por tenant', async () => {
    const repo = new DurableObjectWorkspaceUsageRepository(usageNs());
    expect(await repo.todayTokens('ws_1')).toBe(0);
    expect(await repo.add('ws_1', 100)).toBe(100);
    expect(await repo.add('ws_1', 50)).toBe(150);
    expect(await repo.todayTokens('ws_1')).toBe(150);
    expect(await repo.todayTokens('ws_2')).toBe(0);
  });

  it('ignora tokens negativos y redondea, igual que el adaptador de Redis', async () => {
    const repo = new DurableObjectWorkspaceUsageRepository(usageNs());
    await repo.add('ws', -5);
    expect(await repo.todayTokens('ws')).toBe(0);
    await repo.add('ws', 12.7);
    expect(await repo.todayTokens('ws')).toBe(13);
  });
});
