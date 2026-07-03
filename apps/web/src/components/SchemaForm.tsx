import type { NodeConfigSchema, FieldSchema } from '../editor/node-types';

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
        <label key={key} className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-txt-secondary">{field.label}</span>
          <Field field={field} value={value[key]} onChange={(v) => set(key, v)} />
        </label>
      ))}
    </div>
  );
}

function Field({ field, value, onChange }: { field: FieldSchema; value: unknown; onChange: (v: unknown) => void }) {
  const base =
    'rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-txt-primary outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 placeholder:text-txt-disabled';

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
