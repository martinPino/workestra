import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Bot, Crown, Wrench, Cpu, Plus, Pencil, Trash2, X, Check, Sparkles, Boxes } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Page } from '../app/AppShell';
import { Card, Badge, PageHeader, Button, EmptyState, Skeleton, Input, Textarea, Switch, IconButton } from '../ui';
import { useAgents } from '../lib/hooks';
import { useMediaQuery } from '../lib/useMediaQuery';
import { TOOL_CATALOG, MCP_PRESETS, toolLabel, type McpPreset } from '../lib/tools';
import { McpLogo } from '../lib/mcp-logos';
import { api, type AgentDto, type AgentInput, type AgentDraft, type McpServerRef } from '../lib/api';
import { AgentChatPanel } from '../components/AgentChatPanel';
import { ROLE_PRESETS, AGENT_MODELS } from './agent-roles';
import { agentGradient } from '../lib/agent-avatar';
import { useCan } from '../lib/auth';
import { useT } from '../i18n';

let mcpCounter = 0;
const newMcpId = () => `mcp_${(++mcpCounter).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

const selectCls =
  'h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-txt-primary outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20';

export function Agents() {
  const t = useT();
  const canWrite = useCan('agent:write');
  const { data, isLoading } = useAgents();
  const [editing, setEditing] = useState<AgentDto | 'new' | null>(null);
  const [chatOpen, setChatOpen] = useState(false); // M68: chat flotante «crear asistente con IA»
  const [draft, setDraft] = useState<AgentDraft | null>(null); // borrador de la IA que rellena el formulario
  const [draftNonce, setDraftNonce] = useState(0); // fuerza el remontaje del formulario para re-sembrarlo
  const formWrapRef = useRef<HTMLDivElement>(null);
  const isDesktop = useMediaQuery('(min-width: 768px)');

  // Abre el formulario «Nuevo agente», opcionalmente sembrado con un borrador de la IA (M68).
  const openNew = (seed: AgentDraft | null) => {
    setDraft(seed);
    setDraftNonce((n) => n + 1);
    setEditing('new');
  };

  // Abre el formulario para EDITAR un agente y desplaza la vista hasta él (M70): al pulsar el lápiz de
  // una tarjeta, el editor aparece arriba, así que subimos hasta ahí (mismo `draftNonce` que dispara el scroll).
  const openEdit = (agent: AgentDto) => {
    setEditing(agent);
    setDraftNonce((n) => n + 1);
  };

  // Al recibir un borrador: rellena el formulario y, en móvil, cierra el chat (el panel flotante taparía
  // el botón «Crear agente»); en escritorio el chat queda abierto a la derecha para poder iterar.
  const onDraft = (d: AgentDraft) => {
    openNew(d);
    if (!isDesktop) setChatOpen(false);
  };

  // Al abrir el formulario (nuevo, editar o borrador de IA) subimos la vista hasta él. Con rAF esperamos a
  // que el form monte y el navegador reajuste el scroll (scroll-anchoring, porque el form aparece ARRIBA del
  // viewport); si no, la animación «smooth» compite con ese reajuste y se ve a tirones. Salto directo = fiable.
  useEffect(() => {
    if (draftNonce === 0) return undefined;
    const raf = requestAnimationFrame(() => formWrapRef.current?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(raf);
  }, [draftNonce]);

  return (
    <Page className="space-y-6">
      <PageHeader
        title={t('Agentes')}
        subtitle={t('Especialistas de IA: define su Rol, objetivo, instrucciones y modelo.')}
        actions={
          canWrite && !editing && (
            <Button variant="primary" onClick={() => openNew(null)}>
              <Plus size={15} /> {t('Nuevo agente')}
            </Button>
          )
        }
      />

      <div ref={formWrapRef}>
        {editing && (
          <AgentForm
            key={editing === 'new' ? `new-${draftNonce}` : editing.id}
            initial={editing === 'new' ? null : editing}
            seed={editing === 'new' ? draft ?? undefined : undefined}
            onDone={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        )}
      </div>

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
              canWrite ? (
                <Button variant="primary" onClick={() => openNew(null)}>
                  <Plus size={15} /> {t('Nuevo agente')}
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((agent, i) => (
            <AgentCard key={agent.id} agent={agent} index={i} onEdit={() => openEdit(agent)} />
          ))}
        </div>
      )}

      {/* Chat «crear asistente con IA» (M68): burbuja flotante abajo a la derecha, como en el editor. */}
      {canWrite && !chatOpen && (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          aria-label={t('Crear asistente con IA')}
          title={t('Crear asistente con IA')}
          className="group fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full brand-gradient text-white shadow-pop ring-1 ring-white/15 transition-transform hover:scale-105 active:scale-95"
        >
          <Sparkles size={22} className="transition-transform duration-200 group-hover:rotate-12" />
        </button>
      )}
      {canWrite && chatOpen && <AgentChatPanel onClose={() => setChatOpen(false)} onDraft={onDraft} />}
    </Page>
  );
}

/**
 * Formulario de crear/editar agente. Rol→name, Objetivo→description, Instrucciones→systemPrompt.
 * `seed` (M68): borrador de la IA con el que arranca un agente NUEVO (la persona lo revisa y confirma);
 * los campos se siembran de `initial` (edición) o, si no, de `seed`. El padre remonta el form (key) por
 * cada borrador nuevo, así los `useState` se re-inicializan.
 */
function AgentForm({ initial, seed, onDone, onCancel }: { initial: AgentDto | null; seed?: AgentDraft; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [role, setRole] = useState(initial?.name ?? seed?.name ?? '');
  const [goal, setGoal] = useState(initial?.description ?? seed?.description ?? '');
  const [model, setModel] = useState(initial?.model ?? seed?.model ?? 'llama-3.3-70b-versatile');
  const [instructions, setInstructions] = useState(initial?.systemPrompt ?? seed?.systemPrompt ?? '');
  const [tools, setTools] = useState<string[]>(initial?.tools ?? seed?.tools ?? []);
  // Servidores MCP / conectores del agente (M69): antes solo se podían asignar desde el nodo del editor.
  const [mcpServers, setMcpServers] = useState<McpServerRef[]>(initial?.mcpServers ?? []);
  const [mcpForm, setMcpForm] = useState({ name: '', url: '' });
  const [isOrchestrator, setIsOrchestrator] = useState(initial?.isOrchestrator ?? seed?.isOrchestrator ?? false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const applyPreset = (id: string) => {
    const p = ROLE_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setRole(p.role);
    setGoal(p.goal);
    setInstructions(p.instructions);
    setTools(p.tools);
    setIsOrchestrator(p.isOrchestrator ?? false);
  };

  const toggleMcpPreset = (p: McpPreset) =>
    setMcpServers((cur) =>
      cur.some((s) => s.url === p.url) ? cur.filter((s) => s.url !== p.url) : [...cur, { id: newMcpId(), name: p.name, url: p.url }],
    );
  const removeMcp = (id: string) => setMcpServers((cur) => cur.filter((s) => s.id !== id));
  const addCustomMcp = () => {
    const name = mcpForm.name.trim();
    const url = mcpForm.url.trim();
    if (!name || !/^https?:\/\//i.test(url) || mcpServers.some((s) => s.url === url)) return;
    setMcpServers((cur) => [...cur, { id: newMcpId(), name, url }]);
    setMcpForm({ name: '', url: '' });
  };
  // Servidores propios (no de la lista de populares) para pintarlos como chips con «quitar».
  const customMcp = mcpServers.filter((s) => !MCP_PRESETS.some((p) => p.url === s.url));

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
      tools,
      mcpServers,
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
                <span>{p.emoji}</span> {t(p.role)}
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
        <Field label={t('Herramientas')} hint={t('Lo que el agente puede usar mientras trabaja')} className="md:col-span-2">
          <div className="flex flex-wrap gap-2">
            {TOOL_CATALOG.map((c) => {
              const on = tools.includes(c.key);
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setTools((cur) => (cur.includes(c.key) ? cur.filter((x) => x !== c.key) : [...cur, c.key]))}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                    on ? 'border-primary/60 bg-primary/10 text-txt-primary' : 'border-border bg-surface text-txt-secondary hover:border-border-strong'
                  }`}
                >
                  <c.icon size={13} /> {t(c.label)}
                  {on && <Check size={12} className="text-primary" />}
                </button>
              );
            })}
          </div>
        </Field>

        {/* Conectores / servidores MCP (M69): servicios externos (GitHub, Notion, Salesforce…) que el
            agente puede usar. Antes solo se asignaban desde el nodo del agente en el editor. */}
        <Field
          label={t('Conectores (MCP)')}
          hint={t('Servicios externos que el agente puede usar. Si el servidor necesita clave, conéctalo desde el nodo del agente en el editor.')}
          className="md:col-span-2"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">
              <Boxes size={11} /> {t('Populares')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {MCP_PRESETS.map((p) => {
                const on = mcpServers.some((s) => s.url === p.url);
                return (
                  <button
                    key={p.url}
                    type="button"
                    onClick={() => toggleMcpPreset(p)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                      on ? 'border-primary/60 bg-primary/10 text-txt-primary' : 'border-border bg-surface text-txt-secondary hover:border-border-strong'
                    }`}
                  >
                    <McpLogo server={{ url: p.url, name: p.name }} box={15} /> {p.name}
                    {on && <Check size={12} className="text-primary" />}
                  </button>
                );
              })}
            </div>

            {customMcp.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {customMcp.map((s) => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-primary/60 bg-primary/10 px-2.5 py-1.5 text-xs text-txt-primary"
                  >
                    <McpLogo server={{ url: s.url, name: s.name }} box={15} /> {s.name}
                    <button type="button" aria-label={t('Quitar')} onClick={() => removeMcp(s.id)} className="text-txt-secondary transition-colors hover:text-danger">
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              <input
                value={mcpForm.name}
                onChange={(e) => setMcpForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('Nombre (p. ej. GitHub)')}
                className="h-8 w-36 rounded-lg border border-border bg-surface px-2.5 text-xs text-txt-primary outline-none focus:border-primary/60"
              />
              <input
                value={mcpForm.url}
                onChange={(e) => setMcpForm((f) => ({ ...f, url: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCustomMcp();
                  }
                }}
                placeholder="https://…/mcp"
                className="h-8 min-w-[160px] flex-1 rounded-lg border border-border bg-surface px-2.5 text-xs text-txt-primary outline-none focus:border-primary/60"
              />
              <button
                type="button"
                onClick={addCustomMcp}
                disabled={!mcpForm.name.trim() || !/^https?:\/\//i.test(mcpForm.url.trim())}
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-txt-secondary transition-colors hover:border-border-strong hover:text-txt-primary disabled:opacity-40"
              >
                <Plus size={13} /> {t('Añadir')}
              </button>
            </div>
          </div>
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
  const canWrite = useCan('agent:write');
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
          {canWrite && (
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <IconButton onClick={onEdit} aria-label={t('Editar')}>
                <Pencil size={14} />
              </IconButton>
              <IconButton onClick={() => setConfirming(true)} aria-label={t('Borrar')} className="hover:text-danger">
                <Trash2 size={14} />
              </IconButton>
            </div>
          )}
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
            {agent.tools.map((tk) => (
              <span key={tk} className="inline-flex items-center gap-1 rounded-md bg-elevated px-2 py-0.5 text-[11px] text-txt-secondary">
                <Wrench size={11} /> {toolLabel(tk)}
              </span>
            ))}
            {(agent.mcpServers ?? []).map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1 rounded-md bg-elevated px-2 py-0.5 text-[11px] text-txt-secondary">
                <McpLogo server={{ url: s.url, name: s.name }} box={13} /> {s.name}
              </span>
            ))}
            {agent.tools.length === 0 && (agent.mcpServers ?? []).length === 0 && (
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
