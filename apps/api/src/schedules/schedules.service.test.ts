import { describe, it, expect } from 'vitest';
import type { Queue } from 'bullmq';
import type { ScheduleRecord, SchedulePoll } from '@core/engine';
import type { WorkflowGraph } from '@core/contracts';
import { SchedulesService, isValidCron } from './schedules.service';
import type { PersistenceBundle } from '../persistence/persistence.module';

describe('isValidCron (M7-B, validación con rangos)', () => {
  it('acepta patrones válidos', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true); // 9:00 de lun a vie
    expect(isValidCron('30 0,12 1 */2 *')).toBe(true);
    expect(isValidCron('59 23 31 12 7')).toBe(true); // límites superiores
  });

  it('rechaza campos fuera de rango (que BullMQ rechazaría al disparar)', () => {
    expect(isValidCron('99 * * * *')).toBe(false); // minuto > 59
    expect(isValidCron('* 24 * * *')).toBe(false); // hora > 23
    expect(isValidCron('* * 32 * *')).toBe(false); // día-mes > 31
    expect(isValidCron('* * * 13 *')).toBe(false); // mes > 12
    expect(isValidCron('* * * * 8')).toBe(false); // día-semana > 7
  });

  it('rechaza número de campos incorrecto y basura', () => {
    expect(isValidCron('* * * *')).toBe(false); // 4 campos
    expect(isValidCron('* * * * * *')).toBe(false); // 6 campos
    expect(isValidCron('cada rato')).toBe(false);
    expect(isValidCron('5-2 * * * *')).toBe(false); // rango invertido
  });
});

// --- M53: reconcileFromGraph (el nodo Trigger como fuente única de verdad del sondeo de Drive) ---

type Conn = { id: string; provider: string; status: 'connected' | 'disconnected' };

/** Grafo con un nodo Trigger cuya config declara `eventId` (y `event` del motor). */
function graphWith(config: Record<string, unknown>): WorkflowGraph {
  return { nodes: [{ key: 't', type: 'trigger', position: { x: 0, y: 0 }, config }], edges: [] } as unknown as WorkflowGraph;
}
const driveGraph = (extra: Record<string, unknown> = {}) => graphWith({ event: 'cron', eventId: 'google-drive.file_created', ...extra });
const manualGraph = () => graphWith({ event: 'manual', eventId: 'manual' });

/** SchedulesService con persistencia en memoria (schedules mutables) + cola falsa (o null para simular inline). */
function makeSvc(opts: { connectors?: Conn[]; initial?: ScheduleRecord[]; withQueue?: boolean } = {}) {
  const rows: ScheduleRecord[] = [...(opts.initial ?? [])];
  let seq = rows.length;
  const p = {
    workflows: { get: async (id: string) => ({ id, workspaceId: 'ws', graph: driveGraph() }) },
    connectors: { listByWorkspace: async () => opts.connectors ?? [] },
    schedules: {
      listByWorkflow: async (workflowId: string) => rows.filter((r) => r.workflowId === workflowId),
      get: async (id: string) => rows.find((r) => r.id === id) ?? null,
      create: async (input: { workspaceId: string; workflowId: string; cron: string | null; everyMs: number | null; poll?: SchedulePoll | null }) => {
        const rec: ScheduleRecord = { id: `s${++seq}`, active: true, createdAt: '', poll: input.poll ?? null, ...input };
        rows.push(rec);
        return rec;
      },
      delete: async (id: string) => {
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
      },
    },
  } as unknown as PersistenceBundle;
  const queue = opts.withQueue === false ? null : ({ upsertJobScheduler: async () => undefined, removeJobScheduler: async () => undefined } as unknown as Queue);
  return { svc: new SchedulesService(p, queue), rows };
}

const drivePoll = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: 's1',
  workspaceId: 'ws',
  workflowId: 'wf1',
  cron: null,
  everyMs: 120_000,
  poll: { provider: 'google-drive', connectorId: 'c1' },
  active: true,
  createdAt: '',
  ...over,
});

describe('SchedulesService.reconcileFromGraph (M53)', () => {
  it('crea EXACTAMENTE un poll de Drive resolviendo el único conector conectado del workspace', async () => {
    const { svc, rows } = makeSvc({ connectors: [{ id: 'c1', provider: 'google-drive', status: 'connected' }] });
    await svc.reconcileFromGraph('wf1', 'ws', driveGraph());
    const polls = rows.filter((r) => r.poll?.provider === 'google-drive');
    expect(polls).toHaveLength(1);
    expect(polls[0].poll?.connectorId).toBe('c1');
    expect(polls[0].everyMs).toBe(120_000);
    expect(polls[0].poll?.folderId).toBeUndefined(); // sin carpeta = toda la unidad
  });

  it('es idempotente: publicar dos veces no duplica filas', async () => {
    const { svc, rows } = makeSvc({ connectors: [{ id: 'c1', provider: 'google-drive', status: 'connected' }] });
    await svc.reconcileFromGraph('wf1', 'ws', driveGraph());
    await svc.reconcileFromGraph('wf1', 'ws', driveGraph());
    expect(rows.filter((r) => r.poll?.provider === 'google-drive')).toHaveLength(1);
  });

  it('usa la carpeta declarada en el nodo si la trae', async () => {
    const { svc, rows } = makeSvc({ connectors: [{ id: 'c1', provider: 'google-drive', status: 'connected' }] });
    await svc.reconcileFromGraph('wf1', 'ws', driveGraph({ folderId: 'FOLDER_X', connectorId: 'c9' }));
    const poll = rows.find((r) => r.poll?.provider === 'google-drive')?.poll;
    expect(poll?.folderId).toBe('FOLDER_X');
    expect(poll?.connectorId).toBe('c9'); // el conector del nodo gana al del workspace
  });

  it('preserva la carpeta del poll previo cuando el nodo no la declara (no pisa lo activado con el botón)', async () => {
    const { svc, rows } = makeSvc({
      connectors: [{ id: 'c1', provider: 'google-drive', status: 'connected' }],
      initial: [drivePoll({ poll: { provider: 'google-drive', connectorId: 'c1', folderId: 'KEEP' } })],
    });
    await svc.reconcileFromGraph('wf1', 'ws', driveGraph());
    const polls = rows.filter((r) => r.poll?.provider === 'google-drive');
    expect(polls).toHaveLength(1);
    expect(polls[0].poll?.folderId).toBe('KEEP');
  });

  it('si el disparador ya NO es de Drive, borra el poll huérfano', async () => {
    const { svc, rows } = makeSvc({ initial: [drivePoll()] });
    await svc.reconcileFromGraph('wf1', 'ws', manualGraph());
    expect(rows.filter((r) => r.poll?.provider === 'google-drive')).toHaveLength(0);
  });

  it('sin conector google-drive conectado no crea nada (y no lanza)', async () => {
    const { svc, rows } = makeSvc({ connectors: [{ id: 'c1', provider: 'google-drive', status: 'disconnected' }] });
    await expect(svc.reconcileFromGraph('wf1', 'ws', driveGraph())).resolves.toBeUndefined();
    expect(rows).toHaveLength(0);
  });

  it('con DISPATCH inline (sin cola) no toca nada ni rompe el publish', async () => {
    const { svc, rows } = makeSvc({ connectors: [{ id: 'c1', provider: 'google-drive', status: 'connected' }], withQueue: false });
    await expect(svc.reconcileFromGraph('wf1', 'ws', driveGraph())).resolves.toBeUndefined();
    expect(rows).toHaveLength(0);
  });
});
