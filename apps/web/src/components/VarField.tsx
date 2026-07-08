import { useMemo, useRef, useState } from 'react';
import { TriangleAlert, Braces } from 'lucide-react';
import { useEditorStore } from '../editor/store';
import { availableVars, unknownRefs, type VarSuggestion } from '../editor/graph-vars';
import { useT } from '../i18n';

/** Variables disponibles para el nodo seleccionado (salidas de ancestros + disparador). */
export function useAvailableVars(): VarSuggestion[] {
  const doc = useEditorStore((s) => s.history.doc);
  const selection = useEditorStore((s) => s.selection);
  return useMemo(() => (selection.length === 1 ? availableVars(doc, selection[0]) : []), [doc, selection]);
}

const base =
  'w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-txt-primary outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 placeholder:text-txt-disabled';

/**
 * Campo de texto con INSERTOR de variables + validación (M56). El desplegable lista los datos reales de los
 * pasos anteriores (`{{agent:llm.output}}`…) y los inserta en el cursor; debajo avisa si el texto referencia
 * un paso que no existe (el fallo que dejaba el mensaje de Slack vacío). Reemplaza a un input/textarea suelto.
 */
export function VarField({
  value,
  onChange,
  vars,
  multiline,
  rows = 3,
  placeholder,
  mono,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  vars: VarSuggestion[];
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  mono?: boolean;
  invalid?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const caret = useRef<number | null>(null);
  const [pick, setPick] = useState('');

  const unknown = useMemo(() => unknownRefs(value, vars), [value, vars]);
  const trackCaret = () => {
    const el = ref.current;
    if (el) caret.current = el.selectionStart;
  };

  const insert = (rawRef: string) => {
    if (!rawRef) return;
    const token = `{{${rawRef}}}`;
    const pos = caret.current ?? value.length;
    const next = value.slice(0, pos) + token + value.slice(pos);
    onChange(next);
    setPick('');
    // Reposiciona el cursor tras el token insertado (en el próximo tick, ya con el value nuevo).
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        const p = pos + token.length;
        el.focus();
        el.setSelectionRange(p, p);
        caret.current = p;
      }
    });
  };

  const cls = `${base} ${mono ? 'font-mono' : ''} ${multiline ? 'resize-none' : ''} ${
    invalid || unknown.length ? 'border-danger/70 focus:border-danger/70 focus:ring-danger/20' : ''
  }`;
  const common = {
    ref: ref as never,
    value,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => onChange(e.target.value),
    onSelect: trackCaret,
    onKeyUp: trackCaret,
    onClick: trackCaret,
    className: cls,
  };

  return (
    <div className="flex flex-col gap-1">
      {multiline ? <textarea {...common} rows={rows} spellCheck={mono ? false : undefined} /> : <input type="text" {...common} />}

      {/* Insertor: elige un dato de un paso anterior y se pega como {{referencia}} en el cursor. */}
      <div className="flex items-center gap-1.5">
        <Braces size={11} className="text-txt-disabled" />
        <select
          value={pick}
          onChange={(e) => insert(e.target.value)}
          className="h-7 max-w-full flex-1 truncate rounded-md border border-border bg-surface px-1.5 text-[11px] text-txt-secondary outline-none focus:border-primary/60"
          title={t('Insertar un dato de un paso anterior')}
        >
          <option value="">{vars.length ? t('+ Insertar dato de un paso…') : t('(no hay datos de pasos anteriores)')}</option>
          {vars.map((v) => (
            <option key={v.ref} value={v.ref}>
              {t(v.label)} · {`{{${v.ref}}}`}
            </option>
          ))}
        </select>
      </div>

      {unknown.length > 0 && (
        <span className="flex items-start gap-1 text-[11px] text-danger">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          <span>
            {t('Referencia a un paso que no existe:')} <span className="font-mono">{unknown.map((u) => `{{${u}}}`).join(', ')}</span>.{' '}
            {t('Elige un dato de la lista.')}
          </span>
        </span>
      )}
    </div>
  );
}
