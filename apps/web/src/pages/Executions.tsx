import { useState } from 'react';
import { motion } from 'framer-motion';
import { CircleCheck, CircleX, Loader2, Clock, UserCheck, Check, X, ShieldAlert, Inbox } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Page } from '../app/AppShell';
import { Card, Badge, Dot, PageHeader, Tabs, Button, Input, EmptyState } from '../ui';
import { useExecutions, useReviews } from '../lib/hooks';
import { api, type ExecutionRow, type ReviewDto } from '../lib/api';
import { useAuth, canApprove } from '../lib/auth';
import { useT } from '../i18n';

type Tone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'accent';

const STATUS: Record<string, { tone: Tone; icon: React.ReactNode; label: string }> = {
  SUCCEEDED: { tone: 'success', icon: <CircleCheck size={13} />, label: 'succeeded' },
  FAILED: { tone: 'danger', icon: <CircleX size={13} />, label: 'failed' },
  RUNNING: { tone: 'primary', icon: <Loader2 size={13} className="animate-spin" />, label: 'running' },
  QUEUED: { tone: 'default', icon: <Clock size={13} />, label: 'queued' },
  WAITING_HUMAN: { tone: 'warning', icon: <UserCheck size={13} />, label: 'waiting human' },
  PAUSED: { tone: 'warning', icon: <Clock size={13} />, label: 'paused' },
  CANCELLED: { tone: 'default', icon: <CircleX size={13} />, label: 'cancelled' },
};

const fmtCost = (c: number) => (c === 0 ? '—' : `$${c.toFixed(c < 0.01 ? 4 : 3)}`);

/** Hora de la ejecución (día + hora local) para correlacionar con eventos externos (p. ej. Jira). */
const fmtTime = (iso?: string | null): string =>
  iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

const GRID = 'grid-cols-[1.4fr_0.9fr_1.1fr_0.5fr_0.5fr_0.6fr]';

/** Tarjeta de revisión: aprobar/rechazar una pausa humana. El scope lo valida el servidor (403). */
export function ReviewActions({ executionId }: { executionId: string }) {
  const t = useT();
  const { data: reviews } = useReviews(executionId);
  const { token, role } = useAuth();
  const qc = useQueryClient();
  const [decision, setDecision] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pending = (reviews ?? []).filter((r) => r.status === 'pending');
  if (!pending.length) return null;

  const resolve = async (approved: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      for (const r of pending) await api.resolveReview(executionId, { approved, decision: decision || undefined, reviewId: r.id });
      await Promise.all([qc.invalidateQueries({ queryKey: ['executions'] }), qc.invalidateQueries({ queryKey: ['reviews', executionId] })]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al resolver'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5">
      {pending.map((r: ReviewDto) => (
        <div key={r.id} className="text-xs text-txt-secondary">
          <span className="font-medium text-txt-primary">{r.nodeKey}</span> · {r.reason}
        </div>
      ))}
      {!token ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          <ShieldAlert size={14} /> {t('Necesitas una sesión para aprobar.')}{' '}
          <Link to="/settings" className="underline">
            {t('Generar token')}
          </Link>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Input value={decision} onChange={(e) => setDecision(e.target.value)} placeholder={t('Comentario de decisión (opcional)')} className="h-8 text-xs" />
            <Button size="sm" variant="primary" disabled={busy || !canApprove(role)} onClick={() => resolve(true)}>
              <Check size={14} /> {t('Aprobar')}
            </Button>
            <Button size="sm" variant="danger" disabled={busy || !canApprove(role)} onClick={() => resolve(false)}>
              <X size={14} /> {t('Rechazar')}
            </Button>
          </div>
          {!canApprove(role) && <p className="text-[11px] text-warning">{t('El rol')} {role} {t('no puede aprobar (se requiere execution:approve).')}</p>}
        </>
      )}
      {err && <p className="text-[11px] text-danger">{err}</p>}
    </div>
  );
}

function ExecRow({ e, i }: { e: ExecutionRow; i: number }) {
  const s = STATUS[e.status] ?? STATUS.QUEUED;
  const waiting = e.status === 'WAITING_HUMAN';
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.02 }} className="px-5 py-3">
      <div className={`grid ${GRID} items-center gap-4 text-sm`}>
        <Link to={`/executions/${e.id}`} className="group flex min-w-0 items-center gap-2">
          <span className="font-mono text-[11px] text-txt-disabled group-hover:text-primary">{e.id.slice(0, 12)}</span>
          <span className="truncate text-txt-secondary group-hover:text-txt-primary group-hover:underline">{e.triggerType}</span>
        </Link>
        <Badge tone={s.tone}>
          {s.icon} {s.label}
        </Badge>
        <span className="whitespace-nowrap text-xs text-txt-secondary">{fmtTime(e.createdAt)}</span>
        <span className="text-txt-secondary">{e.tokensUsed.toLocaleString()}</span>
        <span className="text-txt-secondary">{fmtCost(Number(e.costEstimate))}</span>
        <span className="text-right font-mono text-[11px] text-txt-disabled">{e.workflowVersionId?.slice(0, 10)}</span>
      </div>
      {waiting && (
        <div className="mt-3 rounded-lg border border-warning/20 bg-warning/[0.06] p-3">
          <ReviewActions executionId={e.id} />
        </div>
      )}
    </motion.div>
  );
}

export function Executions() {
  const t = useT();
  const [tab, setTab] = useState('all');
  const statusFilter = tab === 'reviews' ? 'WAITING_HUMAN' : undefined;
  const { data, isLoading, error } = useExecutions(statusFilter);
  const waiting = useExecutions('WAITING_HUMAN');
  const waitingCount = waiting.data?.executions.length ?? 0;

  const all = data?.executions ?? [];
  const rows =
    tab === 'ok' ? all.filter((r) => r.status === 'SUCCEEDED') : tab === 'err' ? all.filter((r) => r.status === 'FAILED') : all;

  return (
    <Page className="space-y-6">
      <PageHeader
        title={t('Ejecuciones')}
        subtitle={t('Historial, monitorización en vivo y bandeja de revisiones humanas.')}
        actions={
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { key: 'all', label: t('Todas') },
              { key: 'reviews', label: waitingCount ? `${t('Revisiones')} · ${waitingCount}` : t('Revisiones') },
              { key: 'ok', label: t('Correctas') },
              { key: 'err', label: t('Con incidencias') },
            ]}
          />
        }
      />

      {error ? (
        <EmptyState icon={<CircleX size={20} />} title={t('No se pudo conectar con la API')} description={t('Arranca la API para ver las ejecuciones reales.')} />
      ) : (
        <Card>
          <div className={`grid ${GRID} gap-4 border-b border-border px-5 py-2.5 text-[11px] font-medium uppercase tracking-wide text-txt-disabled`}>
            <span>{t('Ejecución')}</span>
            <span>{t('Estado')}</span>
            <span>{t('Hora')}</span>
            <span>{t('Tokens')}</span>
            <span>{t('Coste')}</span>
            <span className="text-right">{t('Versión')}</span>
          </div>
          {isLoading ? (
            <div className="px-5 py-10 text-center text-txt-secondary">
              <Loader2 size={16} className="mx-auto animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <div className="px-5 py-12">
              <EmptyState
                icon={<Inbox size={20} />}
                title={tab === 'reviews' ? t('Sin revisiones pendientes') : t('Sin ejecuciones todavía')}
                description={
                  tab === 'reviews'
                    ? t('Cuando un workflow con nodo Humano se pause, aparecerá aquí para aprobar o rechazar.')
                    : t('Ejecuta un workflow desde el editor para verlo aquí.')
                }
              />
            </div>
          ) : (
            <div className="divide-y divide-border">
              {rows.map((e, i) => (
                <ExecRow key={e.id} e={e} i={i} />
              ))}
            </div>
          )}
        </Card>
      )}
      <p className="flex items-center gap-1.5 text-xs text-txt-disabled">
        <Dot tone={waitingCount ? 'warning' : 'success'} pulse={!!waitingCount} />
        {waitingCount ? `${waitingCount} ${t('ejecución(es) esperando aprobación humana.')}` : t('Datos en vivo desde la API · refresco cada 3s.')}
      </p>
    </Page>
  );
}
