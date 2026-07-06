import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { CONNECTOR_ACTIONS, type ConnectorAction } from '../editor/connector-actions';
import { useConnectors } from '../lib/hooks';
import { api } from '../lib/api';
import { useT } from '../i18n';

const inputBase =
  'rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-txt-primary outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 placeholder:text-txt-disabled';

function defaultsFor(a?: ConnectorAction): Record<string, string> {
  const o: Record<string, string> = {};
  if (a) for (const f of a.fields) if (f.default !== undefined) o[f.key] = f.default;
  return o;
}

/**
 * Editor del nodo Conector orientado a ACCIONES (M20): el usuario elige una app conectada + una acción
 * («Jira: comentar en el ticket») y rellena campos amigables; por debajo se arma method/path/body (el
 * executor no cambia). La petición HTTP cruda queda bajo «Avanzado». Los campos admiten {{datos}} de pasos
 * anteriores. Sustituye a escribir rutas/JSON/ADF a mano.
 */
export function ConnectorForm({ value, onChange }: { value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const t = useT();
  const { data: connectors } = useConnectors();
  const list = connectors ?? [];
  const connectorId = String(value.connectorId ?? '');
  const provider = list.find((c) => c.id === connectorId)?.provider;
  const actions = provider ? (CONNECTOR_ACTIONS[provider] ?? []) : [];
  const actionId = String(value.action ?? '');
  const action = actions.find((a) => a.id === actionId);
  const params = (value.actionParams && typeof value.actionParams === 'object' ? value.actionParams : {}) as Record<string, string>;
  const [cloudId, setCloudId] = useState<string | undefined>(typeof value.cloudId === 'string' ? value.cloudId : undefined);
  const [advanced, setAdvanced] = useState(!actionId && !!value.path); // legacy: sin acción pero con path → mostrar crudo

  // Para Jira, resolver el cloudId (para las rutas /ex/jira/{cloudid}/…) sin que el usuario lo pegue.
  useEffect(() => {
    if (provider !== 'jira' || !connectorId) return;
    let alive = true;
    api
      .jiraProjects(connectorId)
      .then((r) => {
        if (alive) setCloudId(r.cloudId);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [provider, connectorId]);

  const applyBuilt = (cid: string, aId: string, p: Record<string, string>, cloud: string | undefined) => {
    const prov = list.find((c) => c.id === cid)?.provider;
    const act = (prov ? CONNECTOR_ACTIONS[prov] : undefined)?.find((a) => a.id === aId);
    const base: Record<string, unknown> = { ...value, connectorId: cid, action: aId, actionParams: p, cloudId: cloud };
    if (act) {
      const built = act.build(p, { cloudId: cloud });
      base.method = built.method;
      base.path = built.path;
      base.body = built.body ?? '';
    }
    onChange(base);
  };

  // Cuando llega el cloudId de Jira, rehacer la petición para sustituir el marcador {cloudid} en la ruta.
  // (deps intencionadamente solo [cloudId]: solo re-armamos al resolverse el sitio, no en cada tecla.)
  useEffect(() => {
    if (action && cloudId) applyBuilt(connectorId, actionId, params, cloudId);
  }, [cloudId]);

  const onConnector = (cid: string) => {
    const prov = list.find((c) => c.id === cid)?.provider;
    const first = (prov ? CONNECTOR_ACTIONS[prov] : undefined)?.[0];
    applyBuilt(cid, first?.id ?? '', defaultsFor(first), cloudId);
  };
  const onAction = (aId: string) => applyBuilt(connectorId, aId, defaultsFor(actions.find((a) => a.id === aId)), cloudId);
  const onField = (k: string, v: string) => applyBuilt(connectorId, actionId, { ...params, [k]: v }, cloudId);
  const setRaw = (k: 'method' | 'path' | 'body', v: string) => onChange({ ...value, [k]: v });

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-txt-secondary">{t('App conectada')}</span>
        <select value={connectorId} onChange={(e) => onConnector(e.target.value)} className={inputBase}>
          <option value="">{t('— elige un conector —')}</option>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.key} ({c.provider}){c.status !== 'connected' ? ` ${t('— sin conectar')}` : ''}
            </option>
          ))}
          {list.length === 0 && (
            <option value="" disabled>
              {t('No hay conectores — créalos en Integraciones')}
            </option>
          )}
        </select>
      </label>

      {connectorId && actions.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-txt-secondary">{t('Acción')}</span>
          <select value={actionId} onChange={(e) => onAction(e.target.value)} className={inputBase}>
            <option value="">{t('— elige una acción —')}</option>
            {actions.map((a) => (
              <option key={a.id} value={a.id}>
                {t(a.label)}
              </option>
            ))}
          </select>
        </label>
      )}

      {action &&
        action.fields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-txt-secondary">{t(f.label)}</span>
            {f.multiline ? (
              <textarea value={params[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => onField(f.key, e.target.value)} rows={3} className={`${inputBase} resize-none`} />
            ) : (
              <input type="text" value={params[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => onField(f.key, e.target.value)} className={inputBase} />
            )}
          </label>
        ))}
      {action && action.fields.length > 0 && (
        <p className="text-[11px] text-txt-disabled">{t('Los campos admiten datos de pasos anteriores (p. ej. la clave del ticket).')}</p>
      )}

      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        className="flex items-center gap-1 self-start text-[11px] text-txt-secondary hover:text-txt-primary"
      >
        <ChevronRight size={12} className={advanced ? 'rotate-90 transition-transform' : 'transition-transform'} /> {t('Avanzado (petición HTTP)')}
      </button>
      {advanced && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface/50 p-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-txt-disabled">{t('Método')}</span>
            <select value={String(value.method ?? 'GET')} onChange={(e) => setRaw('method', e.target.value)} className={inputBase}>
              {['GET', 'POST', 'PUT', 'DELETE'].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-txt-disabled">{t('Ruta')}</span>
            <input type="text" value={String(value.path ?? '')} onChange={(e) => setRaw('path', e.target.value)} className={`${inputBase} font-mono`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-txt-disabled">{t('Cuerpo (JSON)')}</span>
            <textarea value={String(value.body ?? '')} onChange={(e) => setRaw('body', e.target.value)} rows={3} spellCheck={false} className={`${inputBase} resize-none font-mono`} />
          </label>
        </div>
      )}
    </div>
  );
}
