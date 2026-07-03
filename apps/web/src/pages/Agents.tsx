import { useState } from 'react';
import { motion } from 'framer-motion';
import { Bot, Crown, Wrench, Cpu, Plus, Pencil, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Page } from '../app/AppShell';
import { Card, Badge, PageHeader, Button, EmptyState, Skeleton, Input, Textarea, Switch, IconButton } from '../ui';
import { useAgents } from '../lib/hooks';
import { api, type AgentDto, type AgentInput } from '../lib/api';
import { ROLE_PRESETS, AGENT_MODELS } from './agent-roles';
import { agentGradient } from '../lib/agent-avatar';
import { useT } from '../i18n';

const selectCls =
  'h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-txt-primary outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20';

export function Agents() {
  const t = useT();
  const { data, isLoading } = useAgents();
  const [editing, setEditing] = useState<AgentDto | 'new' | null>(null);

  return (
    <Page className="space-y-6">
      <PageHeader
        title={t('Agentes')}
        subtitle={t('Especialistas de IA: define su Rol, objetivo, instrucciones y modelo.')}
        actions={
          !editing && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus size={15} /> {t('Nuevo agente')}
            </Button>
          )
        }
      />

      {editing && (
        <AgentForm
          initial={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        !editing && (
          <EmptyState
            icon={<Bot size={22} />}
            title={t('Sin agentes')}
            description={t('Crea agentes especializados con un Rol para tus workflows.')}
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus size={15} /> {t('Nuevo agente')}
              </Button>
            }
          />
        )
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((agent, i) => (
            <AgentCard key={agent.id} agent={agent} index={i} onEdit={() => setEditing(agent)} />
          ))}
        </div>
      )}
    </Page>
  );
}

/** Formulario de crear/editar agente. Rol→name, Objetivo→description, Instrucciones→systemPrompt. */
function AgentForm({ initial, onDone, onCancel }: { initial: AgentDto | null; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [role, setRole] = useState(initial?.name ?? '');
  const [goal, setGoal] = useState(initial?.description ?? '');
  const [model, setModel] = useState(initial?.model ?? 'llama-3.3-70b-versatile');
  const [instructions, setInstructions] = useState(initial?.systemPrompt ?? '');
  const [tools, setTools] = useState((initial?.tools ?? []).join(', '));
  const [isOrchestrator, setIsOrchestrator] = useState(initial?.isOrchestrator ?? false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const applyPreset = (id: string) => {
    const p = ROLE_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setRole(p.role);
    setGoal(p.goal);
    setInstructions(p.instructions);
    setTools(p.tools.join(', '));
    setIsOrchestrator(p.isOrchestrator ?? false);
  };

  const submit = async () => {
    if (!role.trim()) {
      setErr(t('El Rol es obligatorio.'));
      return;
    }
    setSaving(true);
    setErr('');
    const body: AgentInput = {
      name: role.trim(),
      description: goal.trim() || null,
      systemPrompt: instructions.trim() || 'Eres un asistente útil.',
      model,
      tools: tools.split(',').map((t) => t.trim()).filter(Boolean),
      isOrchestrator,
    };
    try {
      if (initial) await api.updateAgent(initial.id, body);
      else await api.createAgent(body);
      await qc.invalidateQueries({ queryKey: ['agents'] });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('No se pudo guardar el agente.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-txt-primary">{initial ? t('Editar agente') : t('Nuevo agente')}</h2>
        <IconButton onClick={onCancel} aria-label={t('Cerrar')}>
          <X size={16} />
        </IconButton>
      </div>

      {!initial && (
        <div className="mb-4">
          <div className="mb-1.5 text-[11px] font-medium text-txt-secondary">{t('Empieza desde un rol predefinido (opcional)')}</div>
          <div className="flex flex-wrap gap-1.5">
            {ROLE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.id)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-txt-secondary transition-colors hover:border-primary/50 hover:text-txt-primary"
              >
                <span>{p.emoji}</span> {p.role}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={t('Rol / función *')} hint={t('Quién es el agente (p. ej. «Investigador»)')}>
          <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder={t('Investigador')} />
        </Field>
        <Field label={t('Modelo')} hint={t('llama-* es gratis vía Groq/Ollama')}>
          <select value={model} onChange={(e) => setModel(e.target.value)} className={selectCls}>
            {AGENT_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Objetivo')} hint={t('Qué debe conseguir (guía al orquestador)')} className="md:col-span-2">
          <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('Buscar y resumir información fiable')} />
        </Field>
        <Field label={t('Instrucciones (system prompt)')} hint={t('Cómo se comporta')} className="md:col-span-2">
          <Textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={t('Eres un investigador meticuloso. Cita fuentes, sé conciso…')} />
        </Field>
        <Field label={t('Herramientas')} hint={t('Opcional, separadas por comas')} className="md:col-span-2">
          <Input value={tools} onChange={(e) => setTools(e.target.value)} placeholder="tool:http, tool:mock" />
        </Field>
      </div>

      <label className="mt-4 flex items-center gap-2.5">
        <Switch checked={isOrchestrator} onChange={setIsOrchestrator} />
        <span className="text-xs text-txt-secondary">
          {t('Agente coordinador (planifica y delega en otros agentes)')}
        </span>
      </label>

      {err && <p className="mt-3 text-xs text-danger">{err}</p>}

      <div className="mt-5 flex items-center gap-2">
        <Button variant="primary" onClick={submit} disabled={saving}>
          {saving ? t('Guardando…') : initial ? t('Guardar cambios') : t('Crear agente')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          {t('Cancelar')}
        </Button>
      </div>
    </Card>
  );
}

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ''}`}>
      <span className="text-[11px] font-medium text-txt-secondary">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-txt-disabled">{hint}</span>}
    </label>
  );
}

function AgentCard({ agent, index, onEdit }: { agent: AgentDto; index: number; onEdit: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const gradient = agentGradient(agent.id);
  const role = agent.permissions?.role ?? 'EDITOR';
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const del = async () => {
    setDeleting(true);
    try {
      await api.deleteAgent(agent.id);
      await qc.invalidateQueries({ queryKey: ['agents'] });
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

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
              {agent.isOrchestrator && <Badge tone="accent">{t('líder')}</Badge>}
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-txt-secondary">{agent.description ?? t('Agente especializado.')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <IconButton onClick={onEdit} aria-label={t('Editar')}>
              <Pencil size={14} />
            </IconButton>
            <IconButton onClick={() => setConfirming(true)} aria-label={t('Borrar')} className="hover:text-danger">
              <Trash2 size={14} />
            </IconButton>
          </div>
        </div>

        {confirming ? (
          <div className="flex items-center justify-between gap-2 border-t border-border bg-danger/5 px-5 py-3">
            <span className="text-xs text-txt-secondary">{t('¿Borrar «')}{agent.name}{t('»?')}</span>
            <div className="flex items-center gap-2">
              <Button variant="danger" size="sm" onClick={del} disabled={deleting}>
                {deleting ? t('Borrando…') : t('Borrar')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={deleting}>
                {t('Cancelar')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-5 py-3">
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
              <span className="inline-flex items-center gap-1 rounded-md bg-elevated px-2 py-0.5 text-[11px] text-txt-disabled">{t('sin tools')}</span>
            )}
            <Badge tone="default" className="ml-auto">
              {role}
            </Badge>
          </div>
        )}
      </Card>
    </motion.div>
  );
}
