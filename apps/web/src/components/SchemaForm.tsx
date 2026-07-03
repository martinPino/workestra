import type { NodeConfigSchema, FieldSchema } from '../editor/node-types';
import { CONNECTOR_ACTIONS } from '../editor/connector-actions';
import { useConnectors } from '../lib/hooks';

const inputBase =
  'rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-txt-primary outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 placeholder:text-txt-disabled';

/**
 * Selector de "acción" (plantilla) según el proveedor del conector elegido. Al elegir una acción
 * rellena method + path + body del nodo; luego el usuario los puede ajustar. Depende de `connectorId`
 * ya seleccionado en el mismo config (para saber el proveedor).
 */
function ActionTemplatePicker({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const { data: connectors } = useConnectors();
  const provider = connectors?.find((c) => c.id === String(value.connectorId ?? ''))?.provider;
  const actions = provider ? (CONNECTOR_ACTIONS[provider] ?? []) : [];
  if (!provider || actions.length === 0) return null;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-txt-secondary">Plantilla de acción ({provider})</span>
      <select
        value=""
        onChange={(e) => {
          const a = actions.find((x) => x.id === e.target.value);
          if (a) onChange({ ...value, method: a.method, path: a.path, body: a.body ?? '' });
        }}
        className={inputBase}
      >
        <option value="">— elige una acción para rellenar ruta + cuerpo —</option>
        {actions.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Desplegable de conectores del workspace (el valor guardado es el id del conector). */
function ConnectorSelect({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const { data: connectors } = useConnectors();
  const list = connectors ?? [];
  return (
    <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={inputBase}>
      <option value="">— elige un conector —</option>
      {list.map((c) => (
        <option key={c.id} value={c.id}>
          {c.key} ({c.provider}){c.status !== 'connected' ? ' — sin conectar' : ''}
        </option>
      ))}
      {list.length === 0 && <option value="" disabled>No hay conectores — créalos en Integraciones</option>}
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
  const entries = Object.entries(schema.fields);
  if (entries.length === 0) {
    return <p className="text-xs text-txt-secondary">Este nodo no tiene propiedades configurables.</p>;
  }
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  return (
    <div className="flex flex-col gap-3">
      {entries.map(([key, field]) => (
        <div key={key} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-txt-secondary">{field.label}</span>
            <Field field={field} value={value[key]} onChange={(v) => set(key, v)} />
          </label>
          {/* Tras elegir el conector, ofrece plantillas de acción que rellenan método/ruta/cuerpo. */}
          {field.type === 'connector' && <ActionTemplatePicker value={value} onChange={onChange} />}
        </div>
      ))}
    </div>
  );
}

function Field({ field, value, onChange }: { field: FieldSchema; value: unknown; onChange: (v: unknown) => void }) {
  const base = inputBase;

  if (field.type === 'connector') {
    return <ConnectorSelect value={value} onChange={onChange} />;
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
    return (
      <textarea value={String(value ?? '')} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} rows={3} className={`${base} resize-none`} />
    );
  }
  return <input type="text" value={String(value ?? '')} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className={base} />;
}
