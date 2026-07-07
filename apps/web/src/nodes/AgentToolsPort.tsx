import { useEffect, useRef, useState } from 'react';
import { Plus, Check, X, Boxes, Wrench } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type McpServerRef } from '../lib/api';
import { TOOL_CATALOG } from '../lib/tools';
import { useT } from '../i18n';

const CIRCLE = 52;
const GAP = 22;
const LINK = 30; // alto del abanico de líneas punteadas del puerto a los círculos

type Item =
  | { kind: 'builtin'; key: string; label: string; icon: typeof Wrench }
  | { kind: 'mcp'; id: string; label: string };

/**
 * Puerto «Herramientas» del nodo Agente estilo n8n (M40): del puerto cuelgan las herramientas del agente como
 * sub-nodos circulares unidos por líneas punteadas, con un «+» para añadir tools internas o SERVIDORES MCP.
 * Al ejecutar, el runtime del agente se conecta a esos servidores y usa sus herramientas. Todo edita el agente
 * (updateAgent). Va absoluto bajo la tarjeta para no desplazar los conectores del nodo.
 */
export function AgentToolsPort({
  agentId,
  tools,
  mcpServers,
  editable,
}: {
  agentId: string;
  tools: string[];
  mcpServers: McpServerRef[];
  editable: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ name: string; url: string }>({ name: '', url: '' });
  const ref = useRef<HTMLDivElement>(null);

  const save = useMutation({
    mutationFn: (patch: { tools?: string[]; mcpServers?: McpServerRef[] }) => api.updateAgent(agentId, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggleBuiltin = (key: string) => save.mutate({ tools: tools.includes(key) ? tools.filter((x) => x !== key) : [...tools, key] });
  const removeMcp = (id: string) => save.mutate({ mcpServers: mcpServers.filter((s) => s.id !== id) });
  const addMcp = () => {
    const name = form.name.trim();
    const url = form.url.trim();
    if (!name || !/^https?:\/\//i.test(url)) return;
    save.mutate({ mcpServers: [...mcpServers, { id: `mcp_${Date.now().toString(36)}`, name, url }] });
    setForm({ name: '', url: '' });
  };

  const items: Item[] = [
    ...tools.map((key): Item => {
      const c = TOOL_CATALOG.find((x) => x.key === key);
      return { kind: 'builtin', key, label: c ? t(c.label) : key, icon: c?.icon ?? Wrench };
    }),
    ...mcpServers.map((s): Item => ({ kind: 'mcp', id: s.id, label: s.name })),
  ];

  const N = items.length;
  const rowW = N > 0 ? N * CIRCLE + (N - 1) * GAP : 0;
  const portX = rowW / 2;
  const cx = (i: number) => i * (CIRCLE + GAP) + CIRCLE / 2;

  return (
    <div ref={ref} className="nodrag absolute left-1/2 top-full z-10 flex -translate-x-1/2 flex-col items-center">
      {/* stub + puerto «Tools» */}
      <span className="h-2.5 w-px bg-border" />
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rotate-45 rounded-[2px] border border-border-strong bg-elevated" />
        <span className="text-[10px] font-medium uppercase tracking-wide text-txt-disabled">{t('Herramientas')}</span>
      </div>
      {editable && (
        <button
          type="button"
          aria-label={t('Añadir herramienta')}
          title={t('Añadir herramienta')}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          className="mt-1 flex h-6 w-6 items-center justify-center rounded-md border border-border bg-elevated text-txt-secondary shadow-subtle transition-colors hover:border-border-strong hover:text-txt-primary"
        >
          <Plus size={13} />
        </button>
      )}

      {/* abanico de líneas + círculos */}
      {N > 0 && (
        <div className="relative mt-1" style={{ width: rowW }}>
          <svg width={rowW} height={LINK} className="absolute left-0 top-0 overflow-visible" aria-hidden="true">
            {items.map((_, i) => (
              <path
                key={i}
                d={`M ${portX} 0 C ${portX} ${LINK * 0.6}, ${cx(i)} ${LINK * 0.4}, ${cx(i)} ${LINK}`}
                fill="none"
                stroke="rgb(var(--border-strong))"
                strokeWidth={1.5}
                strokeDasharray="3 3"
              />
            ))}
          </svg>
          <div className="flex justify-center" style={{ gap: GAP, paddingTop: LINK }}>
            {items.map((it) => (
              <div key={it.kind === 'mcp' ? it.id : it.key} className="group/tool flex flex-col items-center" style={{ width: CIRCLE }}>
                <div className="relative flex items-center justify-center rounded-full border border-border bg-elevated" style={{ width: CIRCLE, height: CIRCLE }}>
                  {it.kind === 'mcp' ? <Boxes size={20} className="text-primary" /> : <it.icon size={19} className="text-txt-secondary" />}
                  {editable && (
                    <button
                      type="button"
                      aria-label={t('Quitar')}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (it.kind === 'mcp') removeMcp(it.id);
                        else toggleBuiltin(it.key);
                      }}
                      className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-border bg-card text-txt-secondary hover:text-danger group-hover/tool:flex"
                    >
                      <X size={9} />
                    </button>
                  )}
                </div>
                <span className="mt-1 max-w-[72px] truncate text-center text-[10px] text-txt-secondary">{it.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* menú de añadir: tools internas + servidor MCP */}
      {open && (
        <div className="absolute top-8 z-30 w-64 rounded-lg border border-border bg-elevated p-2 shadow-pop">
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">{t('Herramientas')}</p>
          {TOOL_CATALOG.map((c) => {
            const on = tools.includes(c.key);
            return (
              <button
                key={c.key}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleBuiltin(c.key);
                }}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-card"
              >
                <span className={`flex h-4 w-4 items-center justify-center rounded border ${on ? 'border-primary bg-primary/20 text-primary' : 'border-border text-transparent'}`}>
                  <Check size={11} strokeWidth={3} />
                </span>
                <c.icon size={13} className="text-txt-secondary" />
                <span className="text-xs text-txt-primary">{t(c.label)}</span>
              </button>
            );
          })}

          <div className="my-1.5 border-t border-border" />
          <p className="flex items-center gap-1.5 px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">
            <Boxes size={11} /> {t('Servidor MCP')}
          </p>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={t('Nombre (p. ej. GitHub)')}
            className="mb-1 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-txt-primary outline-none focus:border-primary/60"
          />
          <input
            value={form.url}
            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addMcp();
              }
            }}
            placeholder="https://…/mcp"
            className="mb-1.5 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-txt-primary outline-none focus:border-primary/60"
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              addMcp();
            }}
            disabled={!form.name.trim() || !/^https?:\/\//i.test(form.url.trim())}
            className="w-full rounded-md bg-primary/15 py-1 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-40"
          >
            {t('Añadir servidor MCP')}
          </button>
          <p className="mt-1.5 px-1 text-[10px] leading-snug text-txt-disabled">
            {t('Si el servidor necesita clave, inclúyela en la URL. Sus herramientas quedarán disponibles para el agente.')}
          </p>
        </div>
      )}
    </div>
  );
}
