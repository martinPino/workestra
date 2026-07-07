import { useEffect, useRef, useState } from 'react';
import { Plus, Check, Wrench } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { TOOL_CATALOG, toolLabel } from '../lib/tools';
import { useT } from '../i18n';

/**
 * Puerto «Herramientas» del nodo Agente (M39, estilo n8n). Se dibuja colgando bajo la tarjeta (absoluto, fuera
 * de flujo, para no desplazar los conectores del nodo) y muestra las herramientas del agente como chips + un
 * «+» para añadir/quitar desde el catálogo. Editar aquí actualiza el AGENTE (su runtime las usa al ejecutar).
 */
export function AgentToolsPort({ agentId, tools, editable }: { agentId: string; tools: string[]; editable: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const save = useMutation({
    mutationFn: (next: string[]) => api.updateAgent(agentId, { tools: next }),
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

  const toggle = (key: string) => {
    const next = tools.includes(key) ? tools.filter((x) => x !== key) : [...tools, key];
    save.mutate(next);
  };

  return (
    <div ref={ref} className="nodrag absolute left-1/2 top-full z-10 flex -translate-x-1/2 flex-col items-center pt-1.5">
      <span className="h-2 w-px bg-border" />
      <div className="flex items-center gap-1 rounded-lg border border-border bg-card px-1.5 py-1 shadow-subtle">
        <span className="pl-0.5 pr-0.5 text-[9px] font-semibold uppercase tracking-wide text-txt-disabled">{t('Herramientas')}</span>
        {tools.map((k) => (
          <span key={k} className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-elevated px-1.5 py-0.5 text-[10px] text-txt-secondary">
            <Wrench size={9} /> {toolLabel(k)}
          </span>
        ))}
        {editable && (
          <button
            type="button"
            aria-label={t('Añadir herramienta')}
            title={t('Añadir herramienta')}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            className="flex h-5 w-5 items-center justify-center rounded-md border border-dashed border-border text-txt-secondary transition-colors hover:border-border-strong hover:text-txt-primary"
          >
            <Plus size={12} />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute top-full z-30 mt-1 w-56 rounded-lg border border-border bg-elevated p-1 shadow-pop">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">{t('Herramientas disponibles')}</p>
          {TOOL_CATALOG.map((c) => {
            const on = tools.includes(c.key);
            return (
              <button
                key={c.key}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(c.key);
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-card"
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    on ? 'border-primary bg-primary/20 text-primary' : 'border-border text-transparent'
                  }`}
                >
                  <Check size={11} strokeWidth={3} />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-txt-primary">{t(c.label)}</span>
                  <span className="block text-[10px] leading-snug text-txt-secondary">{t(c.desc)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
