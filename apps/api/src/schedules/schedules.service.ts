import { Injectable, Inject, BadRequestException, OnModuleInit } from '../http/common';
import type { Queue } from 'bullmq';
import type { WorkflowGraph } from '@core/contracts';
import type { ScheduleRecord, SchedulePoll } from '@core/engine';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/bundle';
import { assertInWorkspace } from '../tenant/tenant.util';
import { triggerEventOf } from '../workflows/trigger.util';
import { SCHEDULE_QUEUE } from '../execution/queue';

// Valida UN campo cron (comodín, paso "/n", número "a", rango "a-b" o listas con ",") en [min,max].
function cronFieldValid(field: string, min: number, max: number): boolean {
  return field.split(',').every((part) => {
    const [range, step] = part.split('/');
    if (step !== undefined && !/^\d+$/.test(step)) return false;
    if (range === '*') return true;
    const inRange = (n: string) => /^\d+$/.test(n) && Number(n) >= min && Number(n) <= max;
    const [a, b] = range.split('-');
    if (b !== undefined) return inRange(a) && inRange(b) && Number(a) <= Number(b);
    return inRange(a);
  });
}

/** Valida un cron de 5 campos CON RANGOS (evita patrones sin sentido que BullMQ rechazaría al disparar). */
export function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const bounds: Array<[number, number]> = [
    [0, 59], // minuto
    [0, 23], // hora
    [1, 31], // día del mes
    [1, 12], // mes
    [0, 7], // día de la semana (0 y 7 = domingo)
  ];
  return parts.every((p, i) => cronFieldValid(p, bounds[i][0], bounds[i][1]));
}

// Topes defensivos (evitan abuso/crecimiento sin límite; configurables por env).
const MIN_EVERY_MS = Math.max(1000, Number(process.env.SCHEDULE_MIN_EVERY_MS ?? 1000)); // ≥ 1s
const MAX_EVERY_MS = Number(process.env.SCHEDULE_MAX_EVERY_MS ?? 30 * 24 * 3600 * 1000); // ≤ 30 días
const MAX_PER_WORKFLOW = Number(process.env.SCHEDULE_MAX_PER_WORKFLOW ?? 20);
// M53: cadencia por defecto del sondeo de Drive que se crea al PUBLICAR (2 min: equilibra latencia y cuota
// de la API de Drive). Configurable por env; sigue acotada por MIN/MAX_EVERY_MS al crear el schedule.
const DRIVE_POLL_EVERY_MS = Number(process.env.DRIVE_POLL_EVERY_MS ?? 120_000);

export interface CreateScheduleInput {
  cron?: string;
  everyMs?: number;
  /** M52: config de sondeo (p. ej. Google Drive). El worker, al disparar, lista los ficheros nuevos. */
  poll?: SchedulePoll;
}

/**
 * Triggers programados (M7-B). Persiste el registro y planifica un JOB SCHEDULER de BullMQ
 * (cron `pattern` o intervalo `every`) cuyo `schedulerId` es el id del schedule. El worker consume
 * cada disparo y arranca una ejecución. Requiere `DISPATCH=queue` (necesita BullMQ). Al arrancar
 * RE-REGISTRA los schedules activos desde la BD (fuente de verdad) por si Redis se vació.
 */
@Injectable()
export class SchedulesService implements OnModuleInit {
  constructor(
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
    @Inject(SCHEDULE_QUEUE) private readonly queue: Queue | null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.queue) return;
    const active = await this.p.schedules.listActive();
    for (const s of active) await this.registerRepeatable(s);
  }

  private repeatOpts(s: { cron: string | null; everyMs: number | null }): { pattern: string } | { every: number } {
    return s.cron ? { pattern: s.cron } : { every: s.everyMs as number };
  }

  private async registerRepeatable(s: ScheduleRecord): Promise<void> {
    if (!this.queue) return;
    await this.queue.upsertJobScheduler(s.id, this.repeatOpts(s), {
      name: 'fire',
      data: { scheduleId: s.id, workflowId: s.workflowId, workspaceId: s.workspaceId },
    });
  }

  async create(workflowId: string, workspaceId: string, input: CreateScheduleInput): Promise<ScheduleRecord> {
    if (!this.queue) {
      throw new BadRequestException('Los triggers programados requieren DISPATCH=queue (BullMQ).');
    }
    const hasCron = typeof input.cron === 'string' && input.cron.trim().length > 0;
    const hasEvery = typeof input.everyMs === 'number' && input.everyMs > 0;
    if (hasCron === hasEvery) {
      throw new BadRequestException('Indica exactamente uno: `cron` (patrón de 5 campos) o `everyMs` (intervalo > 0).');
    }
    if (hasCron && !isValidCron(input.cron as string)) {
      throw new BadRequestException('Patrón cron inválido (5 campos con rangos válidos: min 0-59, hora 0-23, díames 1-31, mes 1-12, díasemana 0-7).');
    }
    if (hasEvery && ((input.everyMs as number) < MIN_EVERY_MS || (input.everyMs as number) > MAX_EVERY_MS)) {
      throw new BadRequestException(`El intervalo debe estar entre ${MIN_EVERY_MS} y ${MAX_EVERY_MS} ms.`);
    }
    const wf = await this.p.workflows.get(workflowId);
    assertInWorkspace(wf?.workspaceId, workspaceId, 'Workflow');
    // El nodo Trigger gobierna la integración: solo se programan disparos si su evento es `cron`.
    if (triggerEventOf(wf?.graph) !== 'cron') {
      throw new BadRequestException(
        `El Trigger de este workflow es «${triggerEventOf(wf?.graph)}», no «cron». Cámbialo en el editor para programar disparos.`,
      );
    }
    const existing = await this.p.schedules.listByWorkflow(workflowId);
    if (existing.length >= MAX_PER_WORKFLOW) {
      throw new BadRequestException(`Máximo ${MAX_PER_WORKFLOW} triggers programados por workflow.`);
    }

    // M52: valida la config de sondeo (opcional). Un poll de Google Drive necesita el conector.
    if (input.poll !== undefined) {
      if (!input.poll || typeof input.poll.provider !== 'string' || typeof input.poll.connectorId !== 'string') {
        throw new BadRequestException('`poll` debe incluir `provider` y `connectorId`.');
      }
    }

    const record = await this.p.schedules.create({
      workspaceId,
      workflowId,
      cron: hasCron ? (input.cron as string).trim() : null,
      everyMs: hasEvery ? (input.everyMs as number) : null,
      poll: input.poll ?? null,
    });
    // Atomicidad (saga): si registrar el repeatable falla, COMPENSA borrando el registro para no
    // dejar una fila huérfana que `onModuleInit` resucitaría en un reinicio (disparo fantasma).
    try {
      await this.registerRepeatable(record);
    } catch (err) {
      await this.p.schedules.delete(record.id).catch(() => undefined);
      throw err;
    }
    return record;
  }

  /**
   * M53 — FUENTE ÚNICA DE VERDAD: reconcilia el sondeo de Google Drive desde el nodo Trigger al PUBLICAR.
   *
   * El bug: configurar el nodo Trigger como «Google Drive: fichero nuevo» NO creaba la fila ScheduledTrigger
   * que el worker sondea (solo la creaba el botón «Vigilar la carpeta» del editor), así que quien únicamente
   * configuraba el nodo se quedaba sin ejecuciones automáticas. Aquí el NODO manda: al publicar, si su evento
   * es Drive garantizamos EXACTAMENTE un poll para el workflow; si ya no es de Drive, limpiamos el que hubiera
   * (cambiar el disparador desactiva el sondeo).
   *
   * Idempotente: borra-y-recrea, de modo que publicar dos veces no duplica filas. Best-effort y BLINDADO:
   * NUNCA rompe la publicación — si no hay cola (DISPATCH!=queue, donde `create` lanza) o algo falla, avisa y
   * vuelve; publicar debe poder completarse siempre (en dev el editor mantiene el botón manual como respaldo).
   */
  async reconcileFromGraph(workflowId: string, workspaceId: string, graph: WorkflowGraph): Promise<void> {
    // Sin BullMQ no hay worker que sondee y `create` lanzaría: saltamos SIN tocar nada para no romper el publish.
    if (!this.queue) {
      console.warn(`[schedule] reconcile ${workflowId}: DISPATCH!=queue; no reconcilio el sondeo de Drive.`);
      return;
    }
    try {
      const trigger = graph?.nodes.find((n) => n.type === 'trigger');
      const cfg = (trigger?.config ?? {}) as Record<string, unknown>;
      // El nodo declara la RECETA humana en `config.eventId` (el `event` del motor solo distingue cron/webhook).
      const isDrive = String(cfg.eventId ?? '') === 'google-drive.file_created';

      // Polls de Drive ya existentes de este workflow: hay que borrarlos (para no duplicar) y de paso poder
      // preservar la carpeta/conector que el usuario ya hubiera fijado con el botón «Vigilar la carpeta».
      const existing = (await this.p.schedules.listByWorkflow(workflowId)).filter((s) => s.poll?.provider === 'google-drive');

      // El disparador ya NO es de Drive: limpia el sondeo huérfano y termina.
      if (!isDrive) {
        for (const s of existing) await this.delete(s.id, workspaceId).catch(() => undefined);
        return;
      }

      // Conector: el que declare el nodo; si no, el del poll previo (respeta lo ya activado); si no, el ÚNICO
      // Drive conectado del workspace. Sin conector conectado no hay token con el que sondear → no creamos nada.
      const prev = existing[0]?.poll ?? undefined;
      let connectorId = typeof cfg.connectorId === 'string' && cfg.connectorId.trim() ? cfg.connectorId.trim() : undefined;
      if (!connectorId) connectorId = prev?.connectorId;
      if (!connectorId) {
        const drives = (await this.p.connectors.listByWorkspace(workspaceId)).filter(
          (c) => c.provider === 'google-drive' && c.status === 'connected',
        );
        if (drives.length === 1) connectorId = drives[0].id; // varios conectores ⇒ ambiguo, que lo fije el nodo/botón
      }
      if (!connectorId) {
        console.warn(`[schedule] reconcile ${workflowId}: sin conector google-drive conectado; no creo el sondeo.`);
        return;
      }

      // Carpeta: la del nodo si la trae; si no, preserva la del poll previo (el botón la guarda ahí). Vacía =
      // toda la unidad (folderId es opcional en el poll), así configurar solo el nodo ya deja el flujo vivo.
      const folderId = typeof cfg.folderId === 'string' && cfg.folderId.trim() ? cfg.folderId.trim() : prev?.folderId;

      // Borra-y-recrea: garantiza EXACTAMENTE un poll de Drive para este workflow (idempotente en republicación).
      for (const s of existing) await this.delete(s.id, workspaceId).catch(() => undefined);
      await this.create(workflowId, workspaceId, {
        everyMs: DRIVE_POLL_EVERY_MS,
        poll: { provider: 'google-drive', connectorId, folderId },
      });
    } catch (err) {
      // Blindaje final: cualquier fallo (cola caída, conector borrado, límites) NO revierte ni rompe el publish.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[schedule] reconcile ${workflowId}: no se pudo reconciliar el sondeo de Drive (${msg}).`);
    }
  }

  async listByWorkflow(workflowId: string, workspaceId: string): Promise<ScheduleRecord[]> {
    const wf = await this.p.workflows.get(workflowId);
    assertInWorkspace(wf?.workspaceId, workspaceId, 'Workflow');
    return this.p.schedules.listByWorkflow(workflowId);
  }

  async delete(id: string, workspaceId: string): Promise<void> {
    const s = await this.p.schedules.get(id);
    if (!s) return;
    assertInWorkspace(s.workspaceId, workspaceId, 'Schedule');
    // Quita el scheduler PRIMERO. NO tragamos el error: si Redis falla, propagamos y NO borramos la
    // fila, de modo que el schedule sigue siendo rastreable y borrable (evita un zombie en Redis que
    // dispararía para siempre sin registro). `removeJobScheduler` devuelve false si no existe (no lanza).
    if (this.queue) await this.queue.removeJobScheduler(id);
    await this.p.schedules.delete(id);
  }
}
