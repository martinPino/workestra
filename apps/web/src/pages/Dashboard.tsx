import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Workflow, Bot, Activity, DollarSign, Cpu, CircleCheck, TriangleAlert, ArrowUpRight, Plus } from 'lucide-react';
import { Page } from '../app/AppShell';
import { Card, Stat, Badge, Dot, Button, PageHeader, Skeleton } from '../ui';
import { useAgents, useWorkflows, useHealth } from '../lib/hooks';
import { useT } from '../i18n';

const MODEL_USAGE = [
  { model: 'claude-opus-4-8', pct: 46, tone: 'bg-primary' },
  { model: 'claude-sonnet-5', pct: 32, tone: 'bg-accent' },
  { model: 'mock-1', pct: 15, tone: 'bg-secondary' },
  { model: 'gpt-5', pct: 7, tone: 'bg-warning' },
];

const ACTIVITY = [
  { t: 'hace 12s', text: 'Orchestrator planificó 2 subtareas', tone: 'primary' as const },
  { t: 'hace 34s', text: 'QA Agent completó una ejecución', tone: 'success' as const },
  { t: 'hace 1m', text: 'Backend Agent invocó la tool http', tone: 'accent' as const },
  { t: 'hace 3m', text: 'Workflow "Bug crítico" desplegado', tone: 'primary' as const },
  { t: 'hace 6m', text: 'Tool no autorizada rechazada por RBAC', tone: 'warning' as const },
];

const SPARK = [8, 12, 9, 16, 14, 22, 18, 26, 21, 30, 24, 34];

export function Dashboard() {
  const t = useT();
  const navigate = useNavigate();
  const agents = useAgents();
  const workflows = useWorkflows();
  const health = useHealth();

  const online = health.isSuccess && health.data?.status === 'ok';

  return (
    <Page className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle={t("Estado del sistema, agentes y ejecuciones en tiempo real.")}
        actions={
          <Button variant="primary" onClick={() => navigate('/workflows?new=1')}>
            <Plus size={15} /> {t("Nuevo workflow")}
          </Button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Workflows"
          value={workflows.isLoading ? <Skeleton className="h-7 w-10" /> : (workflows.data?.length ?? 0)}
          delta={t("+2 esta semana")}
          icon={<Workflow size={18} />}
          tone="primary"
        />
        <Stat
          label={t("Agentes")}
          value={agents.isLoading ? <Skeleton className="h-7 w-10" /> : (agents.data?.length ?? 0)}
          delta={t("1 orchestrator activo")}
          icon={<Bot size={18} />}
          tone="accent"
        />
        <Stat label={t("Ejecuciones (24h)")} value="128" delta={t("+18% vs. ayer")} icon={<Activity size={18} />} tone="success" />
        <Stat label={t("Coste estimado (mes)")} value="$42.10" delta="1.2M tokens" icon={<DollarSign size={18} />} tone="warning" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Actividad en tiempo real */}
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-txt-primary">{t("Actividad en tiempo real")}</h2>
              <Badge tone="success">
                <Dot tone="success" pulse /> {t("en vivo")}
              </Badge>
            </div>
            <button className="flex items-center gap-1 text-xs text-txt-secondary hover:text-txt-primary" onClick={() => navigate('/executions')}>
              {t("Ver todo")} <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="divide-y divide-border">
            {ACTIVITY.map((a, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                className="flex items-center gap-3 px-5 py-3"
              >
                <Dot tone={a.tone} />
                <span className="flex-1 text-sm text-txt-primary">{t(a.text)}</span>
                <span className="text-xs text-txt-disabled">{t(a.t)}</span>
              </motion.div>
            ))}
          </div>
        </Card>

        {/* Estado del sistema */}
        <Card>
          <div className="border-b border-border px-5 py-3.5">
            <h2 className="text-sm font-semibold text-txt-primary">{t("Estado del sistema")}</h2>
          </div>
          <div className="space-y-3 p-5">
            <SystemRow label="API" ok={online} value={online ? t('operativa') : 'offline'} />
            <SystemRow label={t("Motor de ejecución")} ok value="inline" />
            <SystemRow label={t("Cola (BullMQ)")} ok value={t("0 pendientes")} />
            <SystemRow label={t("Errores (24h)")} ok={false} warn value="3" />
          </div>
          <div className="border-t border-border px-5 py-4">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="text-txt-secondary">Throughput</span>
              <span className="font-medium text-txt-primary">{t("34 ejec/h")}</span>
            </div>
            <div className="flex h-12 items-end gap-1">
              {SPARK.map((v, i) => (
                <div key={i} className="flex-1 rounded-sm bg-gradient-to-t from-primary/30 to-primary" style={{ height: `${(v / 34) * 100}%` }} />
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* Uso de modelos */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
            <Cpu size={16} className="text-txt-secondary" />
            <h2 className="text-sm font-semibold text-txt-primary">{t("Uso de modelos")}</h2>
          </div>
          <div className="space-y-4 p-5">
            {MODEL_USAGE.map((m) => (
              <div key={m.model}>
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-mono text-txt-primary">{m.model}</span>
                  <span className="text-txt-secondary">{m.pct}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-elevated">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${m.pct}%` }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                    className={`h-full rounded-full ${m.tone}`}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="flex flex-col">
          <div className="border-b border-border px-5 py-3.5">
            <h2 className="text-sm font-semibold text-txt-primary">{t("Salud")}</h2>
          </div>
          <div className="grid flex-1 grid-cols-2 gap-px overflow-hidden bg-border">
            <HealthTile icon={<CircleCheck size={18} className="text-success" />} label={t("Éxito")} value="97.6%" />
            <HealthTile icon={<TriangleAlert size={18} className="text-warning" />} label={t("Fallos")} value="2.4%" />
            <HealthTile icon={<Activity size={18} className="text-primary" />} label={t("Latencia p50")} value="640ms" />
            <HealthTile icon={<Cpu size={18} className="text-accent" />} label={t("Tokens/ejec")} value="1.4k" />
          </div>
        </Card>
      </div>
    </Page>
  );
}

function SystemRow({ label, value, ok, warn }: { label: string; value: string; ok: boolean; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-txt-secondary">{label}</span>
      <Badge tone={warn ? 'warning' : ok ? 'success' : 'danger'}>
        <Dot tone={warn ? 'warning' : ok ? 'success' : 'danger'} /> {value}
      </Badge>
    </div>
  );
}

function HealthTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex flex-col justify-center gap-1 bg-card p-4">
      {icon}
      <div className="mt-1 text-lg font-semibold text-txt-primary">{value}</div>
      <div className="text-[11px] text-txt-secondary">{label}</div>
    </div>
  );
}
