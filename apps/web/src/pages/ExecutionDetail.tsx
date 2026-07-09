import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactFlow, { Background, BackgroundVariant, type ReactFlowInstance } from 'reactflow';
import 'reactflow/dist/style.css';
import {
  ArrowLeft,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  Radio,
  ChevronDown,
  Coins,
  CircleDollarSign,
  Loader2,
  CircleX,
  AlertTriangle,
  FileDown,
} from 'lucide-react';
import type { ExecutionEvent } from '@core/contracts';
import { reduceExecution, type NodeRunStatus } from '@core/domain';
import { api } from '../lib/api';
import { docToReactFlow, workflowGraphToDoc } from '../graph';
import { AfNode } from '../nodes/AfNode';
import { CommentNode } from '../nodes/CommentNode';
import { AnimatedEdge } from '../edges/AnimatedEdge';
import { Badge, IconButton, EmptyState } from '../ui';
import { ReviewActions } from './Executions';
import { statusLabel } from '../lib/labels';
import { cn } from '../lib/cn';
import { useT } from '../i18n';

type Tone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'accent';

const STATUS_TONE: Record<string, Tone> = {
  UNKNOWN: 'default',
  QUEUED: 'default',
  RUNNING: 'primary',
  WAITING_HUMAN: 'warning',
  SUCCEEDED: 'success',
  FAILED: 'danger',
};

/** Tono por tipo de evento para la timeline. */
const EVENT_TONE: Record<string, Tone> = {
  'execution.queued': 'default',
  'execution.started': 'primary',
  'execution.status': 'warning',
  'node.started': 'primary',
  'node.succeeded': 'success',
  'node.failed': 'danger',
  'browser.action': 'accent',
  'execution.succeeded': 'success',
  'execution.failed': 'danger',
  'plan.created': 'accent',
  'plan.validation_failed': 'danger',
  'subtask.started': 'primary',
  'subtask.succeeded': 'success',
  'subtask.failed': 'danger',
  'plan.execution_failed': 'danger',
  'plan.budget_exceeded': 'danger',
  'results.merged': 'accent',
  'human.requested': 'warning',
  'human.resolved': 'warning',
};

/** Nombre humano de cada acción del navegador (M72) para el historial: `browser_goto` → «Navegar a». */
const BROWSER_ACTION_LABEL: Record<string, string> = {
  browser_open: 'Abrir navegador',
  browser_close: 'Cerrar navegador',
  browser_goto: 'Navegar a',
  browser_click: 'Clic en',
  browser_double_click: 'Doble clic en',
  browser_fill: 'Rellenar',
  browser_type: 'Escribir en',
  browser_press_key: 'Pulsar tecla',
  browser_hover: 'Pasar el cursor por',
  browser_drag_drop: 'Arrastrar',
  browser_scroll: 'Desplazar',
  browser_wait: 'Esperar',
  browser_wait_for_selector: 'Esperar elemento',
  browser_take_screenshot: 'Captura de pantalla',
  browser_generate_pdf: 'Generar PDF',
  browser_extract_text: 'Extraer texto',
  browser_get_html: 'Leer HTML',
  browser_execute_javascript: 'Ejecutar JavaScript',
  browser_get_cookies: 'Leer cookies',
  browser_set_cookies: 'Poner cookies',
  browser_get_console_logs: 'Leer consola',
  browser_get_network_requests: 'Leer red',
  browser_take_snapshot: 'Instantánea de página',
  browser_upload_file: 'Subir fichero',
  browser_download_file: 'Descargar fichero',
};

function eventDetail(e: ExecutionEvent): string {
  // Acción del navegador (M72): «Navegar a → https://…» o «Clic en → button.buy», y el error si falló.
  if (e.type === 'browser.action') {
    const label = BROWSER_ACTION_LABEL[e.action] ?? e.action;
    const parts = [label];
    if (e.target) parts.push(`→ ${e.target}`);
    if (!e.ok && e.error) parts.push(`· ${e.error}`);
    return parts.join(' ');
  }
  if ('nodeKey' in e && e.nodeKey) return String(e.nodeKey);
  return '';
}

type Detail = { label: string; value: unknown; danger?: boolean };

/** Campos de detalle de un evento para el panel expandible (M77): entrada, salida y error de cada paso. */
function eventExtras(e: ExecutionEvent): Detail[] {
  const out: Detail[] = [];
  if (e.type === 'node.started' && e.input !== undefined) out.push({ label: 'Entrada', value: e.input });
  if (e.type === 'node.succeeded') {
    const o = e.output as { data?: unknown; usage?: unknown } | undefined;
    if (o?.data !== undefined) out.push({ label: 'Salida', value: o.data });
  }
  if (e.type === 'subtask.succeeded' && e.output) out.push({ label: 'Salida', value: e.output });
  if (e.type === 'node.failed') out.push({ label: 'Error', value: e.error, danger: true });
  if (e.type === 'execution.failed') out.push({ label: 'Error', value: e.error, danger: true });
  if (e.type === 'subtask.failed') out.push({ label: 'Error', value: e.error, danger: true });
  if (e.type === 'plan.execution_failed') out.push({ label: 'Error', value: e.error, danger: true });
  if (e.type === 'browser.action' && !e.ok && e.error) out.push({ label: 'Error', value: e.error, danger: true });
  return out;
}

/** Formatea un valor de detalle para el `<pre>`: string tal cual; objeto en JSON legible. */
function fmtDetail(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Narración humana de cada tipo de evento del motor (M25): «node.succeeded» → «Paso completado». */
const EVENT_LABEL: Record<string, string> = {
  'execution.queued': 'En cola',
  'execution.started': 'Empezó',
  'execution.status': 'Cambio de estado',
  'node.started': 'Paso iniciado',
  'node.succeeded': 'Paso completado',
  'node.failed': 'Paso con error',
  'node.skipped': 'Paso omitido',
  'browser.action': 'Navegador',
  'execution.succeeded': 'Completado',
  'execution.failed': 'Con error',
  'plan.created': 'Plan del asistente creado',
  'plan.validation_failed': 'Plan inválido',
  'subtask.started': 'Subtarea iniciada',
  'subtask.succeeded': 'Subtarea completada',
  'subtask.failed': 'Subtarea con error',
  'plan.execution_failed': 'La ejecución del plan falló',
  'plan.budget_exceeded': 'Se alcanzó el límite de trabajo permitido',
  'results.merged': 'Resultados combinados',
  'human.requested': 'Pidió tu aprobación',
  'human.resolved': 'Aprobación resuelta',
};
const eventLabel = (type: string): string => EVENT_LABEL[type] ?? type;

interface ConnectorWarning {
  node: string;
  status?: number;
  message: string;
}

/** Intenta sacar un mensaje legible del cuerpo de error de un proveedor (Jira/Slack). */
function extractProviderError(bodyPreview: unknown): string {
  if (typeof bodyPreview !== 'string') return '';
  try {
    const j = JSON.parse(bodyPreview) as Record<string, unknown>;
    const msgs = j.errorMessages; // Jira
    if (Array.isArray(msgs) && msgs.length) return msgs.map(String).join(' ');
    if (typeof j.error === 'string') return j.error; // Slack
    if (typeof j.message === 'string') return j.message;
  } catch {
    /* no era JSON */
  }
  return bodyPreview.slice(0, 160);
}

/**
 * Errores de nodos Conector que NO paran el flujo (M25): el nodo «completa» aunque el proveedor devuelva
 * 4xx/5xx; el error queda en el contexto (`connector:<paso>={ok:false,status,bodyPreview}`). Aquí lo
 * sacamos a la luz para que se vea en el historial en vez de quedar escondido.
 */
function connectorWarnings(context: Record<string, unknown> | undefined): ConnectorWarning[] {
  const vars = (context?.variables ?? {}) as Record<string, unknown>;
  const out: ConnectorWarning[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (!k.startsWith('connector:') || !v || typeof v !== 'object') continue;
    const r = v as { ok?: boolean; status?: number; error?: string; bodyPreview?: unknown };
    if (r.ok === false || r.error) {
      out.push({ node: k.slice('connector:'.length), status: r.status, message: r.error ?? extractProviderError(r.bodyPreview) });
    }
  }
  return out;
}

const fmtCost = (c: number) => (c === 0 ? '—' : `$${c.toFixed(c < 0.01 ? 4 : 3)}`);
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('es-ES', { hour12: false });

/**
 * Miniatura de una captura del navegador (M72): carga perezosa del artefacto (data URL) que la tool
 * «Browser Automation» guardó durante el run, y la muestra bajo su evento en el historial. Al hacer clic
 * se abre a tamaño completo en otra pestaña. Silenciosa: si el fichero caducó (TTL) o falla, no molesta.
 */
function BrowserShot({ execId, fileId }: { execId: string; fileId: string }) {
  const t = useT();
  const { data, isError } = useQuery({
    queryKey: ['execution-file', execId, fileId],
    queryFn: () => api.getExecutionFile(execId, fileId),
    enabled: !!execId && !!fileId,
    retry: false,
    staleTime: Infinity, // el artefacto es inmutable; no re-pedirlo
  });
  if (isError) {
    return <div className="px-3 pb-1.5 text-[10px] text-txt-disabled">{t('Captura no disponible (pudo caducar).')}</div>;
  }
  if (!data) {
    return (
      <div className="flex items-center gap-1.5 px-3 pb-1.5 text-[10px] text-txt-disabled">
        <Loader2 size={11} className="animate-spin" /> {t('Cargando captura…')}
      </div>
    );
  }
  // Solo las imágenes se pintan como miniatura; un PDF/descarga (u otro binario) en un <img> daría el icono
  // de imagen rota, así que se muestra como una «pastilla» de fichero. En ambos casos el clic abre el original.
  const isImage = data.mimeType.startsWith('image/');
  return (
    <div className="px-3 pb-2">
      <a
        href={data.dataUrl}
        target="_blank"
        rel="noreferrer"
        title={isImage ? t('Ver captura a tamaño completo') : t('Abrir fichero')}
        className="inline-block"
      >
        {isImage ? (
          <img
            src={data.dataUrl}
            alt={t('Captura de pantalla del navegador')}
            className="max-h-28 w-auto rounded-md border border-border shadow-subtle transition-shadow hover:shadow-card"
          />
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-2 py-1 text-[11px] text-txt-secondary transition-colors hover:text-txt-primary">
            <FileDown size={12} /> {data.name} <span className="text-txt-disabled">({data.mimeType})</span>
          </span>
        )}
      </a>
    </div>
  );
}

/**
 * Consola de ejecución (M6). El grafo y la timeline se derivan del stream DURABLE de eventos
 * aplicando el reducer puro: `cursor = null` sigue la ejecución EN VIVO; un cursor concreto
 * reproduce el estado EXACTO tras los primeros N eventos (replay determinista, sin re-ejecutar).
 */
export function ExecutionDetail() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [cursor, setCursor] = useState<number | null>(null); // null = en vivo (todos los eventos)
  const [playing, setPlaying] = useState(false);
  const [openEv, setOpenEv] = useState<Set<number>>(new Set()); // filas del timeline con su detalle desplegado (M77)
  const toggleEv = (i: number) =>
    setOpenEv((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  const qc = useQueryClient();
  // Carga inicial (grafo anclado, contexto, reviews, primer tramo de eventos). NO se re-sondea aquí:
  // los eventos crecen por delta (M9); solo se refresca al TERMINAR para las métricas finales.
  const { data, isLoading, error } = useQuery({
    queryKey: ['execution', id],
    queryFn: () => api.getExecution(id as string),
    enabled: !!id,
    retry: false,
  });

  const rf = useRef<ReactFlowInstance | null>(null);
  const nodeTypes = useMemo(() => ({ af: AfNode, comment: CommentNode }), []);
  const edgeTypes = useMemo(() => ({ animated: AnimatedEdge }), []); // arista con luz viajera (M65)
  const timelineRef = useRef<HTMLDivElement | null>(null);

  // Stream ACUMULADO (M9): se siembra con la carga inicial y crece con el delta del poll — nunca se
  // re-transfiere el historial. El estado EN VIVO se deriva del reducer sobre lo acumulado.
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  useEffect(() => {
    if (data?.events?.length) setEvents((prev) => (prev.length ? prev : data.events));
  }, [data?.events]);
  const lastSeqRef = useRef(-1);
  useEffect(() => {
    lastSeqRef.current = events.length ? events[events.length - 1].seq : -1;
  }, [events]);

  const liveStatus = useMemo(() => reduceExecution(events).status, [events]);
  const terminal = liveStatus === 'SUCCEEDED' || liveStatus === 'FAILED';

  // Poll INCREMENTAL: pide solo `seq > lastSeq` y hace append; se detiene al terminar la ejecución.
  useEffect(() => {
    if (!id || terminal) return undefined;
    const t = setInterval(async () => {
      try {
        const { events: delta } = await api.getExecutionEvents(id, lastSeqRef.current);
        if (delta.length) setEvents((prev) => [...prev, ...delta]);
      } catch {
        /* fallo transitorio del poll: se reintenta en el próximo tick */
      }
    }, 2500);
    return () => clearInterval(t);
  }, [id, terminal]);
  // Al terminar, refresca la base UNA vez para las métricas finales (tokens/coste).
  useEffect(() => {
    if (terminal && id) void qc.invalidateQueries({ queryKey: ['execution', id] });
  }, [terminal, id, qc]);

  const visible = cursor == null ? events : events.slice(0, cursor);
  const state = useMemo(() => reduceExecution(visible), [visible]);

  // Autoplay del replay: avanza un evento cada 350ms; al llegar al final vuelve a EN VIVO.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setCursor((c) => {
        const next = (c ?? 0) + 1;
        if (next >= events.length) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, 350);
    return () => clearInterval(t);
  }, [playing, events.length]);

  // La timeline sigue al cursor.
  useEffect(() => {
    const el = timelineRef.current?.querySelector('[data-current="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const statusMap = useMemo(() => {
    const map: Record<string, NodeRunStatus> = {};
    for (const [k, v] of Object.entries(state.nodes)) map[k] = v.status;
    return map;
  }, [state.nodes]);

  const errorMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(state.nodes)) if (v.error) map[k] = v.error;
    return map;
  }, [state.nodes]);

  const { nodes, edges } = useMemo(() => {
    if (!data?.version?.graph) return { nodes: [], edges: [] };
    return docToReactFlow(workflowGraphToDoc(data.version.graph), statusMap, false, errorMap);
  }, [data?.version?.graph, statusMap, errorMap]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-txt-secondary">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }
  if (error || !data?.execution) {
    return (
      <div className="p-8">
        <EmptyState icon={<CircleX size={20} />} title={t('Ejecución no encontrada')} description={t('Comprueba el identificador o vuelve al listado.')} />
      </div>
    );
  }

  const live = cursor == null;
  const position = live ? events.length : cursor;
  const shownStatus = live ? liveStatus : state.status;

  return (
    <div className="flex h-full flex-col">
      {/* Cabecera */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/executions" className="flex items-center gap-1 text-xs text-txt-secondary hover:text-txt-primary">
            <ArrowLeft size={14} /> {t('Ejecuciones')}
          </Link>
          <span className="font-mono text-[11px] text-txt-disabled">{data.executionId}</span>
          <Badge tone={STATUS_TONE[shownStatus] ?? 'default'}>{t(statusLabel(shownStatus))}</Badge>
          {!live && <Badge tone="accent">replay · {position}/{events.length}</Badge>}
        </div>
        <div className="flex items-center gap-3 text-xs text-txt-secondary">
          <span className="flex items-center gap-1">
            <Coins size={13} /> {data.execution.tokensUsed.toLocaleString()} tokens
          </span>
          <span className="flex items-center gap-1">
            <CircleDollarSign size={13} /> {fmtCost(Number(data.execution.costEstimate))}
          </span>
          {data.version && <Badge tone="primary">v{data.version.version}</Badge>}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Grafo read-only con el estado del replay */}
        <div className="relative min-w-0 flex-1 bg-bg">
          {data.version?.graph ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onInit={(inst) => {
                rf.current = inst;
                setTimeout(() => inst.fitView({ padding: 0.25 }), 0);
              }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              deleteKeyCode={null}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="rgb(var(--border))" />
            </ReactFlow>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-txt-secondary">{t('Grafo no disponible.')}</div>
          )}

          {/* Controles de replay (solo cuando hay stream) */}
          {events.length > 0 && (
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border glass px-3 py-2 shadow-pop">
            <IconButton aria-label={t('Al inicio')} onClick={() => { setPlaying(false); setCursor(0); }}>
              <SkipBack size={15} />
            </IconButton>
            <IconButton aria-label={t('Un evento atrás')} onClick={() => { setPlaying(false); setCursor(Math.max(0, position - 1)); }}>
              <ChevronLeft size={15} />
            </IconButton>
            <IconButton aria-label={playing ? t('Pausar') : t('Reproducir')} onClick={() => setPlaying((p) => !p)}>
              {playing ? <Pause size={15} /> : <Play size={15} />}
            </IconButton>
            <IconButton aria-label={t('Un evento adelante')} onClick={() => { setPlaying(false); const n = position + 1; setCursor(n >= events.length ? null : n); }}>
              <ChevronRight size={15} />
            </IconButton>
            <IconButton aria-label={t('Al final')} onClick={() => { setPlaying(false); setCursor(null); }}>
              <SkipForward size={15} />
            </IconButton>
            <input
              type="range"
              min={0}
              max={events.length}
              value={position}
              onChange={(e) => {
                setPlaying(false);
                const v = Number(e.target.value);
                setCursor(v >= events.length ? null : v);
              }}
              className="mx-1 w-44 accent-[rgb(var(--primary))]"
            />
            <button
              onClick={() => { setPlaying(false); setCursor(null); }}
              className={cn(
                'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                live ? 'bg-success/15 text-success' : 'text-txt-secondary hover:text-txt-primary',
              )}
            >
              <Radio size={12} className={live ? 'animate-pulse' : ''} /> {t('En vivo')}
            </button>
          </div>
          )}
        </div>

        {/* Panel lateral: revisiones + plan + timeline */}
        <aside className="flex w-96 shrink-0 flex-col border-l border-border bg-surface">
          {liveStatus === 'WAITING_HUMAN' && (
            <div className="border-b border-border p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-warning">{t('Revisión pendiente')}</div>
              <ReviewActions executionId={data.executionId} />
            </div>
          )}

          {/* M77: error de la ejecución COMPLETO y siempre visible (antes se recortaba a 40 chars). */}
          {state.error && (
            <div className="border-b border-border p-3">
              <div className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-danger">
                <AlertTriangle size={12} /> {t('Error de la ejecución')}
              </div>
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-danger/20 bg-danger/[0.06] p-2.5 text-[11px] leading-relaxed text-danger">
                {state.error}
              </pre>
            </div>
          )}

          {/* M25: errores de conector que no paran el flujo, sacados a la luz (el nodo «completa» con 4xx). */}
          {(() => {
            const warns = connectorWarnings(data.context);
            return warns.length ? (
              <div className="border-b border-border p-3">
                <div className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-warning">
                  <AlertTriangle size={12} /> {t('Avisos de apps conectadas')}
                </div>
                <div className="space-y-1.5">
                  {warns.map((w, i) => (
                    <div key={i} className="rounded-lg border border-warning/20 bg-warning/[0.06] px-2.5 py-1.5 text-[11px] text-txt-secondary">
                      <span className="font-medium text-txt-primary">{w.node}</span>
                      {w.status ? <span className="ml-1 font-mono text-warning">{w.status}</span> : null}
                      {w.message ? <span className="mt-0.5 block text-txt-disabled">{w.message}</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
          })()}

          {state.plan && (
            <div className="border-b border-border p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">{t('Pasos del asistente')}</div>
              <div className="space-y-1.5">
                {state.plan.order.map((sid, i) => {
                  const st = state.plan!.subtasks[sid];
                  const tone: Tone = st.status === 'succeeded' ? 'success' : st.status === 'failed' ? 'danger' : st.status === 'running' ? 'primary' : 'default';
                  return (
                    <div key={sid} className="flex items-center gap-2 text-xs">
                      <Badge tone={tone}>{t('Paso')} {i + 1}</Badge>
                      <span className="truncate text-txt-secondary">{st.task ?? st.agentId}</span>
                    </div>
                  );
                })}
                {state.plan.merged && <div className="text-[11px] text-txt-disabled">{state.plan.merged}</div>}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">
            <span>Timeline · {events.length} {t('eventos')}</span>
            <span className="normal-case text-txt-disabled">{t('toca un paso para ver detalle')}</span>
          </div>
          <div ref={timelineRef} className="min-h-0 flex-1 overflow-y-auto">
            {events.length === 0 ? (
              <div className="p-4 text-xs text-txt-secondary">{t('Sin eventos todavía.')}</div>
            ) : (
              <ol>
                {events.map((e, i) => {
                  const included = i < position;
                  const isCurrent = i === position - 1;
                  // Una acción del navegador fallida se pinta en rojo aunque su tipo base sea 'accent' (M72).
                  const tone = e.type === 'browser.action' && !e.ok ? 'danger' : EVENT_TONE[e.type] ?? 'default';
                  const shotId = e.type === 'browser.action' ? e.screenshotFileId : undefined;
                  const extras = eventExtras(e); // M77: entrada / salida / error del paso
                  const open = openEv.has(i);
                  return (
                    <li key={`${e.seq}-${i}`} data-current={isCurrent}>
                      <button
                        onClick={() => {
                          setPlaying(false);
                          const n = i + 1;
                          setCursor(n >= events.length ? null : n);
                          if (extras.length) toggleEv(i);
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 border-b border-border/50 px-3 py-1.5 text-left text-xs transition-colors hover:bg-elevated/60',
                          !included && 'opacity-35',
                          isCurrent && 'bg-elevated',
                        )}
                      >
                        <span className="w-8 shrink-0 text-right font-mono text-[10px] text-txt-disabled">{e.seq}</span>
                        <Badge tone={tone}><span title={e.type}>{t(eventLabel(e.type))}</span></Badge>
                        <span className="min-w-0 flex-1 truncate text-txt-secondary">{eventDetail(e)}</span>
                        {extras.length > 0 && (
                          <ChevronDown size={12} className={cn('shrink-0 text-txt-disabled transition-transform', open && 'rotate-180')} />
                        )}
                        <span className="shrink-0 font-mono text-[10px] text-txt-disabled">{fmtTime(e.at)}</span>
                      </button>
                      {/* M77: detalle desplegable — entrada, salida y error del paso (JSON legible, con scroll). */}
                      {open &&
                        extras.map((x, xi) => (
                          <div key={xi} className="border-b border-border/50 bg-bg/40 px-3 pb-2 pt-1.5">
                            <div className={cn('mb-1 text-[10px] font-semibold uppercase tracking-wide', x.danger ? 'text-danger' : 'text-txt-disabled')}>
                              {t(x.label)}
                            </div>
                            <pre className={cn('max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 text-[11px] leading-relaxed', x.danger ? 'text-danger' : 'text-txt-secondary')}>
                              {fmtDetail(x.value)}
                            </pre>
                          </div>
                        ))}
                      {/* Miniatura de la captura (M72): solo se pide/pinta cuando el evento ya entró en el replay. */}
                      {shotId && included && id && <BrowserShot execId={id} fileId={shotId} />}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
