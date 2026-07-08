import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { useT } from '../i18n';

const TIP_W = 248; // ancho del globo de error
const TIP_MAX_H = 170; // cota superior de alto (el mensaje se recorta a ~6 líneas) → siempre posicionable

/**
 * Coloca el globo debajo del badge (o encima si no cabe) y SIEMPRE dentro de la pantalla. Usa TIP_MAX_H
 * como cota superior del alto real (el texto está acotado por line-clamp + max-height) para poder
 * garantizar `top + alto <= innerHeight`, sin depender de medir el DOM.
 */
function tipPos(box: DOMRect): { left: number; top: number } {
  const left = Math.max(8, Math.min(box.left + box.width / 2 - TIP_W / 2, window.innerWidth - TIP_W - 8));
  const below = box.bottom + 8;
  const top = below + TIP_MAX_H <= window.innerHeight - 8 ? below : box.top - 8 - TIP_MAX_H;
  return { left, top: Math.max(8, Math.min(top, window.innerHeight - TIP_MAX_H - 8)) };
}

/**
 * Sello de resultado (esquina inferior derecha de la tarjeta): tras ejecutarse, un ✓ verde si el paso
 * fue bien o una ✗ roja si falló. Si falló, al pasar el cursor se abre un globo con el error / lo que
 * falta, breve. El globo se renderiza por PORTAL con posición fija para que NO lo recorte el lienzo de
 * React Flow (que aplica un transform en su viewport). `nodrag` evita que pulsar el sello arrastre el nodo.
 */
export function NodeStatusBadge({ status, error }: { status: 'succeeded' | 'failed'; error?: string }) {
  const t = useT();
  const [box, setBox] = useState<DOMRect | null>(null);
  const failed = status === 'failed';
  const raw = error?.trim() || t('Este paso falló al ejecutarse. Revisa su configuración.');
  // El error del motor no tiene tope de longitud: lo acotamos (breve) para que el globo quepa siempre.
  const msg = raw.length > 300 ? `${raw.slice(0, 300).trimEnd()}…` : raw;

  return (
    <span
      className={`af-check nodrag absolute -bottom-2 -right-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 border-elevated shadow-card ${
        failed ? 'cursor-help bg-danger text-white' : 'bg-success text-[#05140e]'
      }`}
      onMouseEnter={failed ? (e) => setBox(e.currentTarget.getBoundingClientRect()) : undefined}
      onMouseLeave={failed ? () => setBox(null) : undefined}
      aria-label={failed ? `${t('Error')}: ${msg}` : t('Completado')}
    >
      {failed ? <X size={12} strokeWidth={3.5} /> : <Check size={12} strokeWidth={3.5} />}
      {failed &&
        box &&
        createPortal(
          <div
            style={{ position: 'fixed', width: TIP_W, maxHeight: TIP_MAX_H, overflow: 'hidden', ...tipPos(box) }}
            className="pointer-events-none z-[70] rounded-lg border border-danger/40 bg-elevated px-3 py-2 text-[11px] leading-snug text-txt-secondary shadow-xl"
            role="tooltip"
          >
            <span className="mb-0.5 block font-semibold text-danger">{t('Error en este paso')}</span>
            <span
              className="block break-words"
              style={{ display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {msg}
            </span>
          </div>,
          document.body,
        )}
    </span>
  );
}
