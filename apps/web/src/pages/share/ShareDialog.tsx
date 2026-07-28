import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Share2, X, Loader2, Copy, Check, Link2, Trash2, AlertTriangle, Boxes, Bot, EyeOff, Scissors } from 'lucide-react';
import type { ShareReport, ShareStripItem } from '@core/contracts';
import { api } from '../../lib/api';
import { Button, IconButton, Badge } from '../../ui';
import { useT } from '../../i18n';

const cleanError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^HTTP \d+:\s*/, '');

/** Descripción humana de UN item estructural que se quita del grafo al compartir. Clave i18n (español). */
function stripLabel(item: ShareStripItem): string {
  const who = item.provider ? ` (${item.provider.replace(/-/g, ' ')})` : '';
  switch (item.kind) {
    case 'connectorId':
      return `la conexión a la app${who}`;
    case 'accountId':
      return 'el identificador de tu cuenta';
    case 'folderId':
      return 'la carpeta seleccionada';
    case 'mcpServer':
      return 'la URL del servidor MCP';
    case 'header':
      return 'las cabeceras (pueden llevar tu clave de API)';
    case 'urlKey':
      return 'la clave incrustada en la URL';
    case 'toolId':
      return 'las herramientas propias de tu espacio';
    default:
      return 'un dato propio de tu espacio';
  }
}

/** Opciones de caducidad del enlace. `null` = sin caducidad. */
const EXPIRY_OPTIONS: { value: number | null; label: string }[] = [
  { value: 7, label: '7 días' },
  { value: 30, label: '30 días' },
  { value: 90, label: '90 días' },
  { value: null, label: 'Sin caducidad' },
];

/** Botón de copiar al portapapeles con feedback «copiado» (mismo patrón que en Workflows/MCP). */
function CopyBtn({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* portapapeles no disponible: no-op */
        }
      }}
      className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-elevated px-2 py-1 text-[11px] text-txt-secondary hover:text-txt-primary"
    >
      {done ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      {done ? t('Copiado') : t('Copiar')}
    </button>
  );
}

/**
 * Compartir un workflow por enlace (M85). Al abrir hace un `dryRun` para mostrar QUÉ viajaría (estructura e
 * instrucciones), QUÉ se quita (referencias, ids, secretos estructurales) y QUÉ se tapa (secretos en textos).
 * Los secretos de baja confianza (`blocking`) hay que revisarlos y aceptarlos uno a uno antes de crear el enlace.
 */
export function ShareDialog({ workflowId, workflowName, onClose }: { workflowId: string; workflowName: string; onClose: () => void }) {
  const t = useT();
  const [report, setReport] = useState<ShareReport | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [expiresInDays, setExpiresInDays] = useState<number | null>(30);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState('');
  const [created, setCreated] = useState<{ url: string; token: string; expiresAt?: string | null } | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revoked, setRevoked] = useState(false);

  // Cerrar con Escape (patrón de diálogo modal accesible).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !creating) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, creating]);

  // Al abrir: informe de qué viajaría (no crea nada).
  useEffect(() => {
    let alive = true;
    api
      .createShare(workflowId, { dryRun: true })
      .then((res) => {
        if (alive) setReport(res.report);
      })
      .catch((e) => {
        if (alive) setLoadErr(cleanError(e));
      });
    return () => {
      alive = false;
    };
  }, [workflowId]);

  const blocking = report?.blocking ?? [];
  const allAcked = useMemo(() => blocking.every((b) => acked.has(b.location)), [blocking, acked]);
  const toggleAck = (location: string) =>
    setAcked((prev) => {
      const next = new Set(prev);
      if (next.has(location)) next.delete(location);
      else next.add(location);
      return next;
    });

  const createLink = async () => {
    if (creating || !allAcked) return;
    setCreating(true);
    setCreateErr('');
    try {
      const res = await api.createShare(workflowId, {
        dryRun: false,
        acknowledgeBlocking: [...acked],
        expiresInDays,
      });
      if (!res.url || !res.token) {
        setCreateErr(t('No se pudo crear el enlace. Inténtalo de nuevo.'));
        return;
      }
      setCreated({ url: res.url, token: res.token, expiresAt: res.expiresAt });
    } catch (e) {
      setCreateErr(cleanError(e));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async () => {
    if (!created || revoking) return;
    setRevoking(true);
    try {
      await api.revokeShare(created.token);
      setRevoked(true);
    } catch (e) {
      setCreateErr(cleanError(e));
    } finally {
      setRevoking(false);
    }
  };

  const willShare = report?.willShare;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t('Compartir por enlace')}>
      <button type="button" aria-label={t('Cerrar')} className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !creating && onClose()} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative z-10 flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-elevated shadow-pop"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Share2 size={17} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-txt-primary">{t('Compartir por enlace')}</h2>
              <p className="mt-0.5 truncate text-xs text-txt-secondary">{workflowName}</p>
            </div>
          </div>
          <IconButton onClick={onClose} aria-label={t('Cerrar')} disabled={creating}>
            <X size={16} />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loadErr ? (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{loadErr}</div>
          ) : !report ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-txt-secondary">
              <Loader2 size={16} className="animate-spin" /> {t('Preparando la vista previa…')}
            </div>
          ) : created ? (
            // ---- Enlace creado: URL + copiar + caducidad + revocar ----
            <div className="space-y-4">
              {revoked ? (
                <div className="rounded-lg border border-border bg-surface px-3 py-3 text-center text-sm text-txt-secondary">
                  {t('El enlace se ha revocado. Ya no funciona para nadie.')}
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-xs text-success">
                    {t('Enlace listo. Quien lo abra podrá importar una copia a su cuenta.')}
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-txt-secondary">{t('Enlace para compartir')}</div>
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                      <Link2 size={14} className="shrink-0 text-txt-disabled" />
                      <code className="min-w-0 flex-1 truncate font-mono text-xs text-txt-primary">{created.url}</code>
                      <CopyBtn text={created.url} label={t('Copiar enlace')} />
                    </div>
                  </div>
                  <p className="text-[11px] text-txt-disabled">
                    {created.expiresAt
                      ? t('Caduca el') + ' ' + new Date(created.expiresAt).toLocaleDateString()
                      : t('Este enlace no caduca.')}
                  </p>
                </>
              )}
              <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
                {!revoked && (
                  <Button variant="ghost" onClick={revoke} disabled={revoking} className="hover:text-danger">
                    {revoking ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} {t('Revocar')}
                  </Button>
                )}
                <Button variant="secondary" onClick={onClose} className="ml-auto">
                  {t('Hecho')}
                </Button>
              </div>
            </div>
          ) : (
            // ---- Vista previa (dry run): qué viaja / qué se quita / qué se tapa / bloqueos ----
            <div className="space-y-5">
              {/* Se compartirá */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-txt-disabled">
                  <Boxes size={13} /> {t('Se compartirá')}
                </h3>
                <div className="space-y-1.5 text-sm text-txt-secondary">
                  <div className="flex items-center gap-2">
                    <Badge tone="primary">{willShare?.nodeCount ?? 0}</Badge> {t('pasos del flujo')}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="primary">{willShare?.agentCount ?? 0}</Badge>
                    <span className="inline-flex items-center gap-1"><Bot size={13} /> {t('asistentes con sus instrucciones')}</span>
                  </div>
                </div>
                {(willShare?.agentCount ?? 0) > 0 && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] leading-relaxed text-txt-secondary">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
                    <span>{t('Las instrucciones de los asistentes viajan tal cual. Revisa que no contengan datos privados antes de compartir.')}</span>
                  </div>
                )}
              </section>

              {/* Se quitará */}
              {report.structuralStrip.length > 0 && (
                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-txt-disabled">
                    <Scissors size={13} /> {t('Se quitará')}
                  </h3>
                  <ul className="space-y-1">
                    {report.structuralStrip.map((s, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-txt-secondary">
                        <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-txt-disabled" /> {t(stripLabel(s))}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-[11px] text-txt-disabled">{t('Quien lo importe pondrá lo suyo en su lugar.')}</p>
                </section>
              )}

              {/* Se ocultará */}
              {report.contentRedactions.length > 0 && (
                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-txt-disabled">
                    <EyeOff size={13} /> {t('Se ocultará')}
                  </h3>
                  <p className="text-xs text-txt-secondary">
                    {report.contentRedactions.length} {t('posibles secretos detectados y tapados dentro de los textos.')}
                  </p>
                </section>
              )}

              {/* Bloqueos: hay que revisar antes de compartir */}
              {blocking.length > 0 && (
                <section className="rounded-lg border border-warning/40 bg-warning/5 p-3">
                  <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-warning">
                    <AlertTriangle size={13} /> {t('Hay que revisar esto antes de compartir')}
                  </h3>
                  <p className="mb-2 text-[11px] leading-relaxed text-txt-secondary">
                    {t('Esto parece un secreto pero no estamos seguros. Revísalo y, si es seguro, marca «Compartir igualmente».')}
                  </p>
                  <div className="space-y-1.5">
                    {blocking.map((b) => (
                      <label key={b.location} className="flex items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-xs text-txt-secondary">
                        <input
                          type="checkbox"
                          checked={acked.has(b.location)}
                          onChange={() => toggleAck(b.location)}
                          className="mt-0.5 shrink-0 accent-primary"
                        />
                        <span className="min-w-0">
                          <span className="font-medium text-txt-primary">{b.location}</span>
                          <span className="text-txt-disabled"> · {b.pattern}</span>
                          <span className="mt-0.5 block text-[11px]">{t('Compartir igualmente')}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
              )}

              {/* Caducidad */}
              <section>
                <label className="mb-1.5 block text-xs font-medium text-txt-secondary">{t('El enlace caduca en')}</label>
                <select
                  value={expiresInDays === null ? 'null' : String(expiresInDays)}
                  onChange={(e) => setExpiresInDays(e.target.value === 'null' ? null : Number(e.target.value))}
                  aria-label={t('El enlace caduca en')}
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-txt-primary outline-none focus:border-primary/60"
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={String(o.value)} value={o.value === null ? 'null' : String(o.value)}>
                      {t(o.label)}
                    </option>
                  ))}
                </select>
              </section>

              {createErr && <p className="text-xs text-danger">{createErr}</p>}
            </div>
          )}
        </div>

        {/* Pie: crear enlace (solo en vista previa) */}
        {report && !created && !loadErr && (
          <div className="flex items-center justify-end gap-2 border-t border-border p-4">
            <Button variant="ghost" onClick={onClose} disabled={creating}>
              {t('Cancelar')}
            </Button>
            <Button variant="primary" onClick={createLink} disabled={creating || !allAcked} data-track="share-create">
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} {t('Crear enlace')}
            </Button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
