import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Workflow, Bot, CircleCheck, UserCheck, ArrowUpRight, Plus, Inbox, Loader2 } from 'lucide-react';
import { Page } from '../app/AppShell';
import { Card, Stat, Badge, Dot, Button, PageHeader, Skeleton } from '../ui';
import { useAgents, useWorkflows, useExecutions, useHealth } from '../lib/hooks';
import { statusLabel } from '../lib/labels';
import { useT } from '../i18n';

const fmtTime = (iso?: string | null): string =>
  iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

/** Frase de resultado por estado, para la actividad reciente (sin jerga de motor). */
const ACTIVITY_PHRASE: Record<string, string> = {
  SUCCEEDED: 'Una automatización se completó',
  FAILED: 'Una automatización tuvo un error',
  WAITING_HUMAN: 'Una automatización necesita tu aprobación',
  RUNNING: 'Una automatización está en curso',
  QUEUED: 'Una automatización está en cola',
  PAUSED: 'Una automatización está en pausa',
  CANCELLED: 'Una automatización se canceló',
};
type Tone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'accent';
const STATUS_TONE: Record<string, Tone> = {
  SUCCEEDED: 'success',
  FAILED: 'danger',
  WAITING_HUMAN: 'warning',
  RUNNING: 'primary',
  QUEUED: 'default',
};

export function Dashboard() {
  const t = useT();
  const navigate = useNavigate();
  const agents = useAgents();
  const workflows = useWorkflows();
  const executions = useExecutions();
  const waiting = useExecutions('WAITING_HUMAN');
  const health = useHealth();

  const online = health.isSuccess && health.data?.status === 'ok';
  const execs = executions.data?.executions ?? [];
  const waitingCount = waiting.data?.executions.length ?? 0;
  const doneCount = execs.filter((e) => e.status === 'SUCCEEDED').length;

  return (
    <Page className="space-y-6">
      <PageHeader
        title={t('Inicio')}
        subtitle={t('Tus automatizaciones, de un vistazo.')}
        actions={
          <Button variant="primary" onClick={() => navigate('/workflows')}>
            <Plus size={15} /> {t('Nueva automatización')}
          </Button>
        }
      />

      {/* Resultados de negocio (datos reales) */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <button onClick={() => navigate('/workflows')} className="text-left">
          <Stat label={t('Automatizaciones')} value={workflows.isLoading ? <Skeleton className="h-7 w-10" /> : (workflows.data?.length ?? 0)} icon={<Workflow size={18} />} tone="primary" />
        </button>
        <button onClick={() => navigate('/agents')} className="text-left">
          <Stat label={t('Asistentes')} value={agents.isLoading ? <Skeleton className="h-7 w-10" /> : (agents.data?.length ?? 0)} icon={<Bot size={18} />} tone="accent" />
        </button>
        <button onClick={() => navigate('/executions')} className="text-left">
          <Stat label={t('Tareas completadas')} value={executions.isLoading ? <Skeleton className="h-7 w-10" /> : doneCount} icon={<CircleCheck size={18} />} tone="success" />
        </button>
        <button onClick={() => navigate('/executions')} className="text-left">
          <Stat label={t('Necesitan tu revisión')} value={waiting.isLoading ? <Skeleton className="h-7 w-10" /> : waitingCount} icon={<UserCheck size={18} />} tone="warning" />
        </button>
      </div>

      {/* CTA de revisiones pendientes */}
      {waitingCount > 0 && (
        <Card hover className="flex cursor-pointer items-center gap-3 border-warning/30 bg-warning/[0.06] p-4" onClick={() => navigate('/executions')}>
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-warning/15 text-warning">
            <UserCheck size={18} />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-txt-primary">
              {waitingCount} {waitingCount === 1 ? t('tarea espera tu aprobación') : t('tareas esperan tu aprobación')}
            </div>
            <div className="text-xs text-txt-secondary">{t('Ábrelas para aprobar o rechazar.')}</div>
          </div>
          <ArrowUpRight size={16} className="text-warning" />
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Actividad reciente (real) */}
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h2 className="text-sm font-semibold text-txt-primary">{t('Actividad reciente')}</h2>
            <button className="flex items-center gap-1 text-xs text-txt-secondary hover:text-txt-primary" onClick={() => navigate('/executions')}>
              {t('Ver historial')} <ArrowUpRight size={13} />
            </button>
          </div>
          {executions.isLoading ? (
            <div className="px-5 py-10 text-center text-txt-secondary">
              <Loader2 size={16} className="mx-auto animate-spin" />
            </div>
          ) : execs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
              <Inbox size={22} className="text-txt-disabled" />
              <p className="text-sm text-txt-secondary">{t('Aún no hay actividad. Activa una automatización para empezar.')}</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {execs.slice(0, 8).map((e, i) => (
                <motion.div key={e.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }} className="flex items-center gap-3 px-5 py-3">
                  <Dot tone={STATUS_TONE[e.status] ?? 'default'} />
                  <span className="flex-1 text-sm text-txt-primary">{t(ACTIVITY_PHRASE[e.status] ?? statusLabel(e.status))}</span>
                  <span className="text-xs text-txt-disabled">{fmtTime(e.createdAt)}</span>
                </motion.div>
              ))}
            </div>
          )}
        </Card>

        {/* Estado (simple, real) */}
        <Card>
          <div className="border-b border-border px-5 py-3.5">
            <h2 className="text-sm font-semibold text-txt-primary">{t('Estado')}</h2>
          </div>
          <div className="space-y-3 p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-txt-secondary">{t('Conexión con la IA')}</span>
              <Badge tone={online ? 'success' : 'danger'}>
                <Dot tone={online ? 'success' : 'danger'} /> {online ? t('Conectado') : t('Desconectado')}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-txt-secondary">{t('Tareas completadas')}</span>
              <span className="text-sm font-medium text-txt-primary">{doneCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-txt-secondary">{t('Pendientes de revisión')}</span>
              <span className="text-sm font-medium text-txt-primary">{waitingCount}</span>
            </div>
          </div>
        </Card>
      </div>
    </Page>
  );
}
