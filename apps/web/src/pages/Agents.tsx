import { motion } from 'framer-motion';
import { Bot, Crown, Wrench, Cpu, Clock, DollarSign, Plus } from 'lucide-react';
import { Page } from '../app/AppShell';
import { Card, Badge, Dot, PageHeader, Button, EmptyState, Skeleton } from '../ui';
import { useAgents } from '../lib/hooks';
import type { AgentDto } from '../lib/api';

const GRADIENTS = [
  'from-indigo-500 to-fuchsia-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-sky-500 to-blue-500',
  'from-rose-500 to-pink-500',
];

export function Agents() {
  const { data, isLoading } = useAgents();

  return (
    <Page className="space-y-6">
      <PageHeader
        title="Agentes"
        subtitle="Especialistas de IA con modelo, herramientas y permisos propios."
        actions={
          <Button variant="primary">
            <Plus size={15} /> Nuevo agente
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <EmptyState icon={<Bot size={22} />} title="Sin agentes" description="Crea agentes especializados para tus workflows." />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((agent, i) => (
            <AgentCard key={agent.id} agent={agent} gradient={GRADIENTS[i % GRADIENTS.length]} index={i} />
          ))}
        </div>
      )}
    </Page>
  );
}

function AgentCard({ agent, gradient, index }: { agent: AgentDto; gradient: string; index: number }) {
  const role = agent.permissions?.role ?? 'EDITOR';
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }}>
      <Card hover className="group overflow-hidden">
        <div className="flex items-start gap-3 p-5">
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${gradient} text-white shadow-subtle transition-transform group-hover:scale-105`}>
            {agent.isOrchestrator ? <Crown size={20} /> : <Bot size={20} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-txt-primary">{agent.name}</span>
              {agent.isOrchestrator && <Badge tone="accent">líder</Badge>}
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-txt-secondary">{agent.description ?? 'Agente especializado.'}</p>
          </div>
          <Badge tone="default">{role}</Badge>
        </div>

        <div className="flex flex-wrap gap-1.5 px-5 pb-4">
          <span className="inline-flex items-center gap-1 rounded-md bg-elevated px-2 py-0.5 text-[11px] text-txt-secondary">
            <Cpu size={11} /> {agent.model}
          </span>
          {agent.tools.length > 0 ? (
            agent.tools.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-md bg-elevated px-2 py-0.5 text-[11px] text-txt-secondary">
                <Wrench size={11} /> {t}
              </span>
            ))
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md bg-elevated px-2 py-0.5 text-[11px] text-txt-disabled">sin tools</span>
          )}
        </div>

        <div className="grid grid-cols-3 divide-x divide-border border-t border-border text-center">
          <Metric icon={<Clock size={12} />} label="Latencia" value="0.6s" />
          <Metric icon={<DollarSign size={12} />} label="Coste/ejec" value="$0.01" />
          <Metric icon={<Dot tone="success" />} label="Estado" value="listo" />
        </div>
      </Card>
    </motion.div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="px-2 py-3">
      <div className="flex items-center justify-center gap-1 text-txt-secondary">{icon}</div>
      <div className="mt-1 text-xs font-semibold text-txt-primary">{value}</div>
      <div className="text-[10px] text-txt-disabled">{label}</div>
    </div>
  );
}
