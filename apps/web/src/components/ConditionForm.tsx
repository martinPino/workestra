import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useT } from '../i18n';

const inputBase =
  'rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-txt-primary outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 placeholder:text-txt-disabled';

type Rule = { field: string; op: string; value: string };
type Combinator = '&&' | '||';

/** Operadores humanos → símbolo que entiende el evaluador (`~` = «contiene»). */
const OPS: { key: string; label: string }[] = [
  { key: '==', label: 'es igual a' },
  { key: '!=', label: 'no es igual a' },
  { key: '>', label: 'mayor que' },
  { key: '<', label: 'menor que' },
  { key: '~', label: 'contiene' },
];

/** Descompone la expresión guardada en reglas para poblar el builder. */
function parseExpr(expr: string): { rules: Rule[]; combinator: Combinator } {
  const trimmed = (expr ?? '').trim();
  const empty: Rule = { field: '', op: '==', value: '' };
  if (!trimmed || trimmed === 'true') return { rules: [empty], combinator: '&&' };
  const combinator: Combinator = trimmed.includes('||') ? '||' : '&&';
  const rules = trimmed.split(combinator).map((p) => {
    const m = p.match(/^\s*([\w.]+)\s*(==|!=|>=|<=|>|<|~)\s*(.+?)\s*$/);
    return m ? { field: m[1], op: m[2], value: m[3].replace(/^["']|["']$/g, '') } : { ...empty, field: p.trim() };
  });
  return { rules: rules.length ? rules : [empty], combinator };
}

/** Compila las reglas a la expresión que evalúa el motor (`campo op valor && …`). */
function compileExpr(rules: Rule[], combinator: Combinator): string {
  const clauses = rules.filter((r) => r.field.trim()).map((r) => `${r.field.trim()} ${r.op} ${r.value.trim()}`);
  return clauses.length ? clauses.join(` ${combinator} `) : 'true';
}

/**
 * Constructor de reglas VISUAL para el nodo Condición (M21): filas [dato][operador][valor] combinables con
 * Y/O, sin escribir «Expresión» ni sintaxis. Compila por debajo a la forma que evalúa el motor.
 */
export function ConditionForm({ value, onChange }: { value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const t = useT();
  const initial = parseExpr(String(value.expression ?? ''));
  const [rules, setRules] = useState<Rule[]>(initial.rules);
  const [combinator, setCombinator] = useState<Combinator>(initial.combinator);

  const apply = (nextRules: Rule[], nextComb: Combinator) => {
    setRules(nextRules);
    setCombinator(nextComb);
    onChange({ ...value, expression: compileExpr(nextRules, nextComb) });
  };
  const setRule = (i: number, patch: Partial<Rule>) => apply(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)), combinator);
  const addRule = () => apply([...rules, { field: '', op: '==', value: '' }], combinator);
  const removeRule = (i: number) => apply(rules.filter((_, j) => j !== i), combinator);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-txt-secondary">{t('Continúa si…')}</span>
        {rules.length > 1 && (
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
            {(['&&', '||'] as Combinator[]).map((c) => (
              <button
                key={c}
                onClick={() => apply(rules, c)}
                className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${combinator === c ? 'bg-elevated text-txt-primary' : 'text-txt-disabled hover:text-txt-secondary'}`}
              >
                {c === '&&' ? t('se cumplen TODAS') : t('se cumple ALGUNA')}
              </button>
            ))}
          </div>
        )}
      </div>

      {rules.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input value={r.field} onChange={(e) => setRule(i, { field: e.target.value })} placeholder={t('dato (p. ej. ticket.summary)')} className={`${inputBase} min-w-0 flex-1`} />
          <select value={r.op} onChange={(e) => setRule(i, { op: e.target.value })} className={inputBase}>
            {OPS.map((o) => (
              <option key={o.key} value={o.key}>
                {t(o.label)}
              </option>
            ))}
          </select>
          <input value={r.value} onChange={(e) => setRule(i, { value: e.target.value })} placeholder={t('valor')} className={`${inputBase} w-24`} />
          {rules.length > 1 && (
            <button onClick={() => removeRule(i)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-txt-secondary hover:bg-danger/15 hover:text-danger" aria-label={t('Quitar')}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      ))}

      <button onClick={addRule} className="flex items-center gap-1 self-start text-[11px] text-primary hover:underline">
        <Plus size={12} /> {t('Añadir regla')}
      </button>
      <p className="text-[11px] text-txt-disabled">{t('Si se cumple, el flujo sigue por «sí»; si no, por «no».')}</p>
    </div>
  );
}
