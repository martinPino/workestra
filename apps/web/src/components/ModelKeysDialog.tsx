import { useEffect, useState } from 'react';
import { X, KeyRound, Trash2, Check } from 'lucide-react';
import { Button, IconButton, Input } from '../ui';
import { api, type LlmKeyView } from '../lib/api';
import { useT } from '../i18n';

const PROVIDERS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'openai', label: 'OpenAI', hint: 'sk-…' },
  { id: 'anthropic', label: 'Anthropic', hint: 'sk-ant-…' },
  { id: 'openrouter', label: 'OpenRouter', hint: 'sk-or-…' },
  { id: 'groq', label: 'Groq', hint: 'gsk_…' },
];

/**
 * BYOK (M35): el workspace añade SUS propias claves de IA. Si hay clave para un proveedor, la IA del
 * workspace usa esa (su saldo) en vez de la de plataforma. La clave se guarda cifrada; nunca vuelve al cliente.
 */
export function ModelKeysDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [keys, setKeys] = useState<LlmKeyView[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      setKeys(await api.listLlmKeys());
    } catch {
      setErr(t('No se pudieron cargar las claves.'));
    }
  };
  useEffect(() => {
    load();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const has = (p: string) => keys.find((k) => k.provider === p);
  const save = async (p: string) => {
    const v = (drafts[p] ?? '').trim();
    if (!v) return;
    setBusy(p);
    setErr(null);
    try {
      await api.setLlmKey(p, v);
      setDrafts((d) => ({ ...d, [p]: '' }));
      await load();
    } catch (e) {
      const detail = e instanceof Error ? (e.message.match(/^HTTP \d+:\s*(.+)/)?.[1] ?? '') : '';
      setErr(detail || t('No se pudo guardar la clave.'));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (p: string) => {
    setBusy(p);
    try {
      await api.removeLlmKey(p);
      await load();
    } catch {
      setErr(t('No se pudo quitar la clave.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t('Tus claves de IA')}>
      <button type="button" aria-label={t('Cerrar')} className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-lg">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <KeyRound size={16} />
            </span>
            <div>
              <h2 className="text-base font-semibold text-txt-primary">{t('Usa tu propia clave de IA')}</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-txt-secondary">
                {t('Si añades tu clave, la IA de tu espacio usará esa (tu saldo) en vez de la de la plataforma. Se guarda cifrada.')}
              </p>
            </div>
          </div>
          <IconButton onClick={onClose} aria-label={t('Cerrar')}>
            <X size={16} />
          </IconButton>
        </div>

        <div className="mt-4 space-y-2.5">
          {PROVIDERS.map((p) => {
            const set = has(p.id);
            return (
              <div key={p.id} className="rounded-lg border border-border bg-card p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-txt-primary">{p.label}</span>
                  {set && (
                    <span className="flex items-center gap-1 text-[11px] text-success">
                      <Check size={11} /> {t('conectada')} · <code className="font-mono text-txt-disabled">…{set.last4}</code>
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <Input
                    type="password"
                    value={drafts[p.id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        save(p.id);
                      }
                    }}
                    placeholder={set ? t('Reemplazar clave…') : p.hint}
                    aria-label={`${t('Clave de')} ${p.label}`}
                  />
                  <Button variant="secondary" size="sm" disabled={busy === p.id || !(drafts[p.id] ?? '').trim()} onClick={() => save(p.id)}>
                    {t('Guardar')}
                  </Button>
                  {set && (
                    <IconButton aria-label={t('Quitar')} onClick={() => remove(p.id)} className="hover:text-danger">
                      <Trash2 size={14} />
                    </IconButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {err && <p className="mt-2 text-xs text-danger">{err}</p>}
      </div>
    </div>
  );
}
