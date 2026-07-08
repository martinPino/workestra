import { useEffect, useState } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useT } from '../i18n';

/**
 * Panel de «razonamiento» que se muestra mientras la IA monta o modifica el flujo (M31). No es streaming
 * real —el backend hace una sola llamada— sino las FASES reales del pipeline (analizar la petición, elegir
 * los nodos, conectarlos y validar el DAG) animadas para que la espera sea legible y se entienda qué está
 * pasando, como en n8n/ChatGPT. Al terminar (`done`), todos los pasos quedan marcados.
 */
export function ThinkingSteps({ done = false, steps: stepsProp }: { done?: boolean; steps?: string[] }) {
  const t = useT();
  // Fases por defecto (montar un flujo). `steps` permite adaptarlas a otro contexto (p. ej. crear un asistente).
  const steps = stepsProp ?? [
    t('Analizando tu petición'),
    t('Eligiendo los nodos adecuados'),
    t('Conectando los pasos'),
    t('Validando el flujo'),
  ];
  const [current, setCurrent] = useState(0);
  const [open, setOpen] = useState(true);

  // Avanza el paso activo cada ~1,1 s mientras trabaja; se queda en el último (girando) hasta que `done`.
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setCurrent((c) => Math.min(c + 1, steps.length - 1)), 1100);
    return () => clearInterval(id);
  }, [done, steps.length]);

  return (
    <div className="rounded-xl border border-border bg-elevated/40 p-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-xs font-medium text-txt-secondary"
        aria-expanded={open}
      >
        {done ? <Check size={13} className="text-success" /> : <Loader2 size={13} className="animate-spin text-primary" />}
        <span>{done ? t('Listo') : t('Pensando')}</span>
        <ChevronDown size={13} className={`ml-auto transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <ul className="mt-2.5 space-y-1.5" aria-live="polite">
          {steps.map((s, i) => {
            const state = done || i < current ? 'done' : i === current ? 'active' : 'pending';
            return (
              <li key={s} className="flex items-center gap-2 text-[11px]">
                {state === 'done' ? (
                  <Check size={12} className="shrink-0 text-success" />
                ) : state === 'active' ? (
                  <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
                ) : (
                  <span className="h-3 w-3 shrink-0 rounded-full border border-border" />
                )}
                <span className={state === 'pending' ? 'text-txt-disabled' : 'text-txt-secondary'}>{s}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
