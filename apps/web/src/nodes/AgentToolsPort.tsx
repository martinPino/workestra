import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Plus, Check, X, Boxes, Wrench, TriangleAlert, Plug, Brain } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type McpServerRef } from '../lib/api';
import { TOOL_CATALOG, MCP_PRESETS, INTEGRATION_PRESETS, isIntegrationUrl, integrationPresetForUrl } from '../lib/tools';
import { MEMORY_MODES, memoryModeOf, hasMemory } from '../lib/memory';
import { useConnectors } from '../lib/hooks';
import { McpLogo } from '../lib/mcp-logos';
import { useT } from '../i18n';

const CIRCLE = 52;
const GAP = 22;
const LINK = 30; // alto del abanico de líneas punteadas del puerto a los círculos

type Item =
  | { kind: 'builtin'; key: string; label: string; icon: typeof Wrench }
  | { kind: 'mcp'; id: string; label: string; url: string }
  | { kind: 'memory'; label: string };

/**
 * Aviso + «Conectar» de un servidor MCP (M43/M45). Verifica la conexión (con la credencial guardada si está
 * conectado); si falla, pinta el triángulo rojo. Al pasar el cursor, muestra un TOOLTIP con el motivo y, si
 * faltan credenciales, un botón «Conectar» que abre un diálogo para pegar la credencial (se guarda cifrada y
 * se usa como `Authorization` al ejecutar). Muchos MCP usan tu cuenta personal, así que necesitan permiso.
 */
function McpWarn({ server }: { server: { id: string; name: string; url: string } }) {
  const t = useT();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState(false);
  const [token, setToken] = useState('');

  const q = useQuery({
    queryKey: ['mcp-verify', server.id],
    queryFn: () => api.verifyMcp(server.url, server.id),
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const connect = useMutation({
    mutationFn: () => api.connectMcp(server.id, token),
    onSuccess: () => {
      setDialog(false);
      setToken('');
      qc.invalidateQueries({ queryKey: ['mcp-verify', server.id] });
    },
  });

  if (!q.data || q.data.ok) return null;
  const needsAuth = q.data.needsAuth;
  const msg = needsAuth
    ? q.data.connected
      ? `${t('La credencial de')} ${server.name} ${t('no es válida. Vuelve a conectar.')}`
      : `${t('Faltan las credenciales para')} ${server.name}. ${t('Conéctalo para activarlo.')}`
    : q.data.connected
      ? // Se envió una credencial y aun así falla sin ser 401/403 (p. ej. el MCP remoto de Atlassian exige
        // OAuth y devuelve 404 con un token que no es OAuth): mensaje honesto en vez de un genérico.
        `${t('La credencial no funcionó o')} ${server.name} ${t('requiere iniciar sesión (OAuth).')}`
      : `${t('No se pudo conectar con')} ${server.name}.`;

  return (
    <span className="group/warn absolute -bottom-1.5 left-1/2 z-20 -translate-x-1/2">
      <span className="flex h-4 w-4 items-center justify-center rounded-full border-2 border-elevated bg-danger text-white shadow-card">
        <TriangleAlert size={9} strokeWidth={2.75} />
      </span>
      {/* Tooltip en hover (con puente `pb` para que no parpadee al pasar al botón). */}
      <span className="absolute bottom-full left-1/2 hidden -translate-x-1/2 pb-1.5 group-hover/warn:block">
        <span className="pointer-events-auto block w-max max-w-[210px] rounded-lg border border-border bg-elevated p-2 text-[11px] leading-snug text-txt-secondary shadow-pop">
          {msg}
          {needsAuth && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDialog(true);
              }}
              className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md bg-primary/15 py-1 text-[11px] font-medium text-primary hover:bg-primary/25"
            >
              <Plug size={11} /> {t('Conectar')}
            </button>
          )}
        </span>
      </span>

      {dialog &&
        createPortal(
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" aria-label={t('Cerrar')} className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDialog(false)} />
            <div className="relative w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-lg">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <McpLogo server={server} box={28} />
                  <h2 className="text-base font-semibold text-txt-primary">
                    {t('Conectar')} {server.name}
                  </h2>
                </div>
                <button type="button" aria-label={t('Cerrar')} onClick={() => setDialog(false)} className="text-txt-disabled hover:text-txt-primary">
                  <X size={16} />
                </button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-txt-secondary">
                {t('Pega tu credencial (token o clave de API). Se guarda cifrada y se usa para autorizar el servidor.')}
              </p>
              <input
                type="password"
                value={token}
                autoFocus
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && token.trim()) connect.mutate();
                }}
                placeholder={t('Token o clave de API')}
                className="mt-3 w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-txt-primary outline-none focus:border-primary/60"
              />
              {connect.isError && <p className="mt-2 text-xs text-danger">{t('No se pudo conectar. Revisa la credencial.')}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setDialog(false)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-txt-secondary hover:text-txt-primary">
                  {t('Cancelar')}
                </button>
                <button
                  type="button"
                  disabled={!token.trim() || connect.isPending}
                  onClick={() => connect.mutate()}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40"
                >
                  {t('Conectar')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * Aviso de una INTEGRACIÓN de primera clase (M76) enganchada al agente (ref `integration://…`). A diferencia
 * de un MCP con token pegado, aquí la plataforma es dueña del OAuth: el aviso solo mira si el conector OAuth
 * del workspace (por `provider`) está CONECTADO. Si no lo está, muestra un enlace a Integraciones para
 * conectarlo una vez; el agente nunca ve el token.
 */
function IntegrationWarn({ server }: { server: { name: string; url: string } }) {
  const t = useT();
  const preset = integrationPresetForUrl(server.url);
  const { data: connectors } = useConnectors();
  if (!preset) return null;
  const connected = (connectors ?? []).some((c) => c.provider === preset.provider && c.status === 'connected');
  if (connected) return null; // conectado → sin aviso; las herramientas ya funcionan

  return (
    <span className="group/warn absolute -bottom-1.5 left-1/2 z-20 -translate-x-1/2">
      <span className="flex h-4 w-4 items-center justify-center rounded-full border-2 border-elevated bg-warning text-white shadow-card">
        <TriangleAlert size={9} strokeWidth={2.75} />
      </span>
      <span className="absolute bottom-full left-1/2 hidden -translate-x-1/2 pb-1.5 group-hover/warn:block">
        <span className="pointer-events-auto block w-max max-w-[220px] rounded-lg border border-border bg-elevated p-2 text-[11px] leading-snug text-txt-secondary shadow-pop">
          {t('Conecta {name} en Integraciones para activar sus herramientas.').replace('{name}', server.name)}
          <Link
            to="/integrations"
            onClick={(e) => e.stopPropagation()}
            className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md bg-primary/15 py-1 text-[11px] font-medium text-primary hover:bg-primary/25"
          >
            <Plug size={11} /> {t('Conectar')}
          </Link>
        </span>
      </span>
    </span>
  );
}

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
  memoryScope,
  editable,
}: {
  agentId: string;
  tools: string[];
  mcpServers: McpServerRef[];
  memoryScope?: string | null;
  editable: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ name: string; url: string }>({ name: '', url: '' });
  const ref = useRef<HTMLDivElement>(null);

  const save = useMutation({
    mutationFn: (patch: { tools?: string[]; mcpServers?: McpServerRef[]; memoryScope?: string | null }) => api.updateAgent(agentId, patch),
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
    setOpen(false); // cerrar el menú al añadir el servidor
  };
  const addPreset = (p: { name: string; url: string }) => {
    if (mcpServers.some((s) => s.url === p.url)) return; // ya añadido
    save.mutate({ mcpServers: [...mcpServers, { id: `mcp_${Date.now().toString(36)}`, name: p.name, url: p.url }] });
    setOpen(false);
  };
  // M76: engancha una integración de primera clase como ref sentinela `integration://<key>` (sin token).
  const addIntegration = (p: { name: string; url: string }) => {
    if (mcpServers.some((s) => s.url === p.url)) return;
    save.mutate({ mcpServers: [...mcpServers, { id: `int_${Date.now().toString(36)}`, name: p.name, url: p.url }] });
    setOpen(false);
  };

  // M81: la memoria cuelga del mismo puerto que las herramientas —es otra capacidad que le añades al agente—,
  // primera de la fila para que se lea «este agente recuerda, y además usa estas tools».
  const setMemory = (scope: string | null) => {
    save.mutate({ memoryScope: scope });
    setOpen(false);
  };

  const items: Item[] = [
    ...(hasMemory(memoryScope) ? [{ kind: 'memory', label: t(memoryModeOf(memoryScope).label) } as Item] : []),
    ...tools.map((key): Item => {
      const c = TOOL_CATALOG.find((x) => x.key === key);
      return { kind: 'builtin', key, label: c ? t(c.label) : key, icon: c?.icon ?? Wrench };
    }),
    ...mcpServers.map((s): Item => ({ kind: 'mcp', id: s.id, label: s.name, url: s.url })),
  ];

  const N = items.length;
  const rowW = N > 0 ? N * CIRCLE + (N - 1) * GAP : 0;
  const portX = rowW / 2;
  const cx = (i: number) => i * (CIRCLE + GAP) + CIRCLE / 2;

  return (
    <div
      ref={ref}
      data-tools-open={open || undefined}
      className="nodrag absolute left-1/2 top-full z-10 flex -translate-x-1/2 flex-col items-center"
    >
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
              <div
                key={it.kind === 'mcp' ? it.id : it.kind === 'memory' ? 'memory' : it.key}
                className="group/tool flex flex-col items-center"
                style={{ width: CIRCLE }}
              >
                <div
                  className={`relative flex items-center justify-center rounded-full border bg-elevated ${
                    it.kind === 'memory' ? 'border-primary/50' : 'border-border'
                  }`}
                  style={{ width: CIRCLE, height: CIRCLE }}
                >
                  {it.kind === 'mcp' ? (
                    <McpLogo server={{ url: it.url, name: it.label }} box={30} />
                  ) : it.kind === 'memory' ? (
                    <Brain size={19} className="text-primary" />
                  ) : (
                    <it.icon size={19} className="text-txt-secondary" />
                  )}
                  {it.kind === 'mcp' &&
                    (isIntegrationUrl(it.url) ? (
                      <IntegrationWarn server={{ name: it.label, url: it.url }} />
                    ) : (
                      <McpWarn server={{ id: it.id, name: it.label, url: it.url }} />
                    ))}
                  {editable && (
                    <button
                      type="button"
                      aria-label={t('Quitar')}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (it.kind === 'mcp') removeMcp(it.id);
                        else if (it.kind === 'memory') setMemory(null);
                        else toggleBuiltin(it.key);
                      }}
                      className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-border bg-card text-txt-secondary hover:text-danger group-hover/tool:flex"
                    >
                      <X size={9} />
                    </button>
                  )}
                </div>
                <span className={`mt-1 max-w-[72px] truncate text-center text-[10px] ${it.kind === 'memory' ? 'text-primary' : 'text-txt-secondary'}`}>{it.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* menú de añadir: tools internas + servidor MCP */}
      {open && (
        <div className="absolute top-8 z-30 max-h-[70vh] w-64 overflow-y-auto rounded-lg border border-border bg-elevated p-2 shadow-pop">
          {/* Memoria (M81): una sola elección —qué recuerda el agente— antes de las herramientas que puede usar. */}
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">
              <Brain size={11} /> {t('Memoria')}
            </span>
            <button
              type="button"
              aria-label={t('Cerrar')}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-txt-disabled transition-colors hover:text-txt-primary"
            >
              <X size={12} />
            </button>
          </div>
          {MEMORY_MODES.map((m) => {
            const on = (memoryScope ?? null) === m.value;
            return (
              <button
                key={m.value ?? 'off'}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMemory(m.value);
                }}
                className="flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-card"
              >
                <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${on ? 'border-primary' : 'border-border'}`}>
                  {on && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                </span>
                <span className="min-w-0">
                  <span className={`block text-xs ${on ? 'text-txt-primary' : 'text-txt-secondary'}`}>{t(m.label)}</span>
                  <span className="block text-[10px] leading-snug text-txt-disabled">{t(m.desc)}</span>
                </span>
              </button>
            );
          })}

          <div className="my-1.5 border-t border-border" />
          <p className="flex items-center gap-1.5 px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">
            <Wrench size={11} /> {t('Herramientas')}
          </p>
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

          {/* Integraciones de primera clase (M76): acceso gestionado por la plataforma (OAuth), sin pegar claves. */}
          <div className="my-1.5 border-t border-border" />
          <p className="flex items-center gap-1.5 px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">
            <Plug size={11} /> {t('Integraciones')}
          </p>
          <div className="mb-1 flex flex-wrap gap-1">
            {INTEGRATION_PRESETS.map((p) => {
              const added = mcpServers.some((s) => s.url === p.url);
              return (
                <button
                  key={p.url}
                  type="button"
                  disabled={added}
                  onClick={(e) => {
                    e.stopPropagation();
                    addIntegration(p);
                  }}
                  title={added ? t('Ya añadido') : t('Acceso gestionado por la plataforma (OAuth). Conéctalo una vez en Integraciones.')}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[11px] transition-colors ${
                    added
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-border bg-surface text-txt-secondary hover:border-border-strong hover:text-txt-primary'
                  }`}
                >
                  <McpLogo server={{ name: p.name }} box={16} /> {p.name} {added && <Check size={10} />}
                </button>
              );
            })}
          </div>
          <p className="mb-1 px-1 text-[10px] text-txt-disabled">{t('Acceso gestionado por la plataforma — sin pegar claves.')}</p>

          <div className="my-1.5 border-t border-border" />
          <p className="flex items-center gap-1.5 px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">
            <Boxes size={11} /> {t('Servidor MCP')}
          </p>

          {/* Presets populares: añadir de un clic sin escribir la URL (M41). */}
          <p className="px-1 pb-1 text-[10px] text-txt-disabled">{t('Populares')}</p>
          <div className="mb-2 flex flex-wrap gap-1">
            {MCP_PRESETS.map((p) => {
              const added = mcpServers.some((s) => s.url === p.url);
              return (
                <button
                  key={p.url}
                  type="button"
                  disabled={added}
                  onClick={(e) => {
                    e.stopPropagation();
                    addPreset(p);
                  }}
                  title={added ? t('Ya añadido') : p.url}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[11px] transition-colors ${
                    added
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-border bg-surface text-txt-secondary hover:border-border-strong hover:text-txt-primary'
                  }`}
                >
                  <McpLogo server={{ url: p.url, name: p.name }} box={16} /> {p.name} {added && <Check size={10} />}
                </button>
              );
            })}
          </div>

          <p className="px-1 pb-1 text-[10px] text-txt-disabled">{t('O añade uno propio')}</p>
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
