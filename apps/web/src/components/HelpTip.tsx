import { useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

/**
 * Icono de ayuda con tooltip (M59): al pasar el cursor o pulsar, muestra una explicación breve. El globo se
 * renderiza por PORTAL con posición FIJA, así no lo recorta el `overflow` del sidebar estrecho de la paleta.
 * `onClick` hace stopPropagation para no disparar la acción del bloque contenedor (p. ej. añadir el nodo).
 */
const TIP_W = 224; // = w-56

/** Coloca el globo a la DERECHA del icono si cabe; si no, a la izquierda; siempre dentro de la pantalla. */
function tipPos(box: DOMRect): { left: number; top: number } {
  const right = box.right + 8;
  const left = right + TIP_W + 8 <= window.innerWidth ? right : box.left - TIP_W - 8;
  return { left: Math.max(8, Math.min(left, window.innerWidth - TIP_W - 8)), top: Math.max(8, box.top - 4) };
}

export function HelpTip({ text }: { text: string }) {
  const [box, setBox] = useState<DOMRect | null>(null);
  if (!text) return null;
  const open = (el: HTMLElement) => setBox(el.getBoundingClientRect());
  return (
    <span
      className="ml-auto flex shrink-0 cursor-help items-center text-txt-disabled transition-colors hover:text-primary"
      onMouseEnter={(e) => open(e.currentTarget)}
      onMouseLeave={() => setBox(null)}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (box) setBox(null);
        else open(e.currentTarget);
      }}
      role="button"
      tabIndex={-1}
      aria-label={text}
    >
      <HelpCircle size={13} strokeWidth={2} />
      {box &&
        createPortal(
          <div
            style={{ position: 'fixed', ...tipPos(box) }}
            className="pointer-events-none z-[70] w-56 rounded-lg border border-border bg-elevated px-3 py-2 text-[11px] leading-snug text-txt-secondary shadow-xl"
          >
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}
