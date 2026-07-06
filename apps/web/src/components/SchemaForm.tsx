import { useState } from 'react';
import type { NodeConfigSchema, FieldSchema } from '../editor/node-types';
import { useConnectors, useAgents } from '../lib/hooks';
import { useT } from '../i18n';

const inputBase =
  'rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-txt-primary outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 placeholder:text-txt-disabled';

/**
 * Valida que `s` sea JSON válido, tolerando los `{{placeholders}}` de interpolación. En runtime, con
 * jsonSafe, cada placeholder se incrusta como FRAGMENTO de string JSON (debe ir DENTRO de comillas:
 * `"...{{x}}..."`), así que para validar se sustituye cada uno por vacío — reproduciendo esa
 * semántica. De ese modo `"t":"{{x}}"` valida, pero un placeholder como valor SUELTO `{"a":{{x}}}`
 * (que en runtime generaría JSON inválido) se marca correctamente como error, sin falsos positivos.
 * Devuelve `null` si es válido o está vacío; si no, el mensaje del parser.
 */
function validateJsonTemplate(s: string): string | null {
  const t = s.trim();
  if (t === '') return null; // el cuerpo es opcional
  const probe = s.replace(/\{\{[^}]+\}\}/g, '');
  if (probe.trim() === '') return null; // el cuerpo es solo placeholder(s): se resuelve en runtime
  try {
    JSON.parse(probe);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^JSON\.parse:\s*/, '') : 'JSON inválido';
  }
}

/** Unidades de tiempo humanas → milisegundos. El valor guardado SIEMPRE es ms (el motor no cambia). */
const DURATION_UNITS: { key: string; label: string; ms: number }[] = [
  { key: 'ms', label: 'ms', ms: 1 },
  { key: 's', label: 'segundos', ms: 1_000 },
  { key: 'm', label: 'minutos', ms: 60_000 },
  { key: 'h', label: 'horas', ms: 3_600_000 },
  { key: 'd', label: 'días', ms: 86_400_000 },
];

/** Elige la mayor unidad en la que `ms` se expresa como entero exacto (p. ej. 60000 → «1 minuto»). */
function bestUnit(ms: number): (typeof DURATION_UNITS)[number] {
  if (!ms) return DURATION_UNITS[1]; // 0 → segundos por defecto (evita mostrar «0 ms»)
  for (let i = DURATION_UNITS.length - 1; i >= 1; i--) {
    if (ms % DURATION_UNITS[i].ms === 0) return DURATION_UNITS[i];
  }
  return DURATION_UNITS[0];
}

/**
 * Campo de duración: número + selector de unidad para quien no piensa en milisegundos. Guarda ms.
 * Cambiar de unidad NO altera la duración real: solo re-expresa el mismo valor (60000 ms ↔ 1 min).
 */
function DurationField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const t = useT();
  const ms = Number(value ?? 0);
  const [unitKey, setUnitKey] = useState(() => bestUnit(ms).key);
  const unit = DURATION_UNITS.find((u) => u.key === unitKey) ?? DURATION_UNITS[1];
  const amount = ms / unit.ms;
  return (
    <div className="flex gap-2">
      <input
        type="number"
        min={0}
        value={Number.isFinite(amount) ? amount : 0}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Math.round(Number(e.target.value) * unit.ms))}
        className={`${inputBase} w-full`}
      />
      <select value={unitKey} onChange={(e) => setUnitKey(e.target.value)} className={inputBase}>
        {DURATION_UNITS.map((u) => (
          <option key={u.key} value={u.key}>
            {t(u.label)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Desplegable de agentes del workspace (el valor guardado es el id del agente). */
function AgentSelect({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const t = useT();
  const { data: agents } = useAgents();
  const list = agents ?? [];
  return (
    <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={inputBase}>
      <option value="">{t('— agente inline (usa la config del nodo LLM) —')}</option>
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} ({a.model}){a.isOrchestrator ? ` · ${t('líder')}` : ''}
        </option>
      ))}
      {list.length === 0 && (
        <option value="" disabled>
          {t('No hay agentes — créalos en la sección Agentes')}
        </option>
      )}
    </select>
  );
}

/** Desplegable de conectores del workspace (el valor guardado es el id del conector). */
function ConnectorSelect({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const t = useT();
  const { data: connectors } = useConnectors();
  const list = connectors ?? [];
  return (
    <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={inputBase}>
      <option value="">{t('— elige un conector —')}</option>
      {list.map((c) => (
        <option key={c.id} value={c.id}>
          {c.key} ({c.provider}){c.status !== 'connected' ? ` ${t('— sin conectar')}` : ''}
        </option>
      ))}
      {list.length === 0 && <option value="" disabled>{t('No hay conectores — créalos en Integraciones')}</option>}
    </select>
  );
}

interface Props {
  schema: NodeConfigSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

/** Genera un formulario a partir del JSON Schema del tipo de nodo (panel schema-driven). */
export function SchemaForm({ schema, value, onChange }: Props) {
  const t = useT();
  const entries = Object.entries(schema.fields);
  if (entries.length === 0) {
    return <p className="text-xs text-txt-secondary">{t('Este nodo no tiene propiedades configurables.')}</p>;
  }
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  return (
    <div className="flex flex-col gap-3">
      {entries.map(([key, field]) => (
        <div key={key} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-txt-secondary">{t(field.label)}</span>
            <Field field={field} value={value[key]} onChange={(v) => set(key, v)} />
          </label>
        </div>
      ))}
    </div>
  );
}

function Field({ field, value, onChange }: { field: FieldSchema; value: unknown; onChange: (v: unknown) => void }) {
  const t = useT();
  const base = inputBase;

  if (field.type === 'connector') {
    return <ConnectorSelect value={value} onChange={onChange} />;
  }
  if (field.type === 'agent') {
    return <AgentSelect value={value} onChange={onChange} />;
  }
  if (field.type === 'duration') {
    return <DurationField value={value} onChange={onChange} />;
  }
  if (field.type === 'boolean') {
    return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--primary))]" />;
  }
  if (field.type === 'number') {
    return (
      <input
        type="number"
        value={value === undefined ? '' : Number(value)}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className={base}
      />
    );
  }
  if (field.type === 'enum') {
    return (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={base}>
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (field.multiline) {
    const text = String(value ?? '');
    const jsonError = field.format === 'json' ? validateJsonTemplate(text) : null;
    return (
      <>
        <textarea
          value={text}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          spellCheck={field.format === 'json' ? false : undefined}
          className={`${base} resize-none ${jsonError ? 'border-danger/70 focus:border-danger/70 focus:ring-danger/20' : ''}`}
        />
        {field.format === 'json' && jsonError && (
          <span className="text-[11px] text-danger">{t('JSON inválido:')} {jsonError}</span>
        )}
        {field.format === 'json' && !jsonError && text.trim() !== '' && (
          <span className="text-[11px] text-txt-disabled">{t('JSON válido ·')} {'{{variables}}'} {t('permitidas')}</span>
        )}
      </>
    );
  }
  return <input type="text" value={String(value ?? '')} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className={base} />;
}
