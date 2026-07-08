import { useEffect, useRef, useState } from 'react';
import { type NodeProps, NodeResizer } from 'reactflow';
import { Trash2 } from 'lucide-react';
import type { CommentNodeData } from '../graph';
import { useEditorStore } from '../editor/store';
import { useT } from '../i18n';

/** Paletas de la nota (M60). Clases LITERALES para que Tailwind las incluya. `amber` por defecto (tipo sticky). */
export const NOTE_COLORS: Record<string, { bg: string; border: string; ring: string; dot: string }> = {
  amber: { bg: 'bg-amber-900/80', border: 'border-amber-700/70', ring: 'ring-amber-500', dot: 'bg-amber-600' },
  slate: { bg: 'bg-slate-700/80', border: 'border-slate-500/70', ring: 'ring-slate-300', dot: 'bg-slate-400' },
  sky: { bg: 'bg-sky-900/80', border: 'border-sky-700/70', ring: 'ring-sky-500', dot: 'bg-sky-500' },
  emerald: { bg: 'bg-emerald-900/80', border: 'border-emerald-700/70', ring: 'ring-emerald-500', dot: 'bg-emerald-500' },
  pink: { bg: 'bg-pink-900/80', border: 'border-pink-700/70', ring: 'ring-pink-500', dot: 'bg-pink-500' },
  violet: { bg: 'bg-violet-900/80', border: 'border-violet-700/70', ring: 'ring-violet-500', dot: 'bg-violet-500' },
};
const COLOR_KEYS = Object.keys(NOTE_COLORS);

/** Renderiza el cuerpo tipo markdown-lite: líneas con «- »/«• »/«* » → viñetas; el resto, párrafos. */
function renderBody(lines: string[]) {
  return lines.map((raw, i) => {
    const l = raw.trim();
    if (!l) return <div key={i} className="h-1.5" />;
    if (/^[-•*]\s*/.test(l)) {
      return (
        <div key={i} className="flex gap-1.5">
          <span className="mt-px shrink-0 text-white/40">•</span>
          <span className="min-w-0 break-words">{l.replace(/^[-•*]\s*/, '')}</span>
        </div>
      );
    }
    return (
      <div key={i} className="break-words">
        {l}
      </div>
    );
  });
}

/**
 * Nota/sticky del lienzo (M60): fondo de color, 1ª línea como TÍTULO en negrita y las líneas «- » como viñetas.
 * Doble clic para editar (textarea con el texto crudo); al seleccionarla aparece una barra con la paleta de
 * colores y la papelera. Se persiste con el grafo (sobrevive a recargas).
 */
export function CommentNode({ data, selected }: NodeProps<CommentNodeData>) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(data.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const updateCommentText = useEditorStore((s) => s.updateCommentText);
  const setColor = useEditorStore((s) => s.setCommentColorById);
  const setSize = useEditorStore((s) => s.setCommentSizeById);
  const setSizeLive = useEditorStore((s) => s.setCommentSizeLive);
  const remove = useEditorStore((s) => s.removeCommentById);
  const resizeStart = useRef<{ width?: number; height?: number }>({}); // tamaño al empezar a tirar (para el undo)
  const active = data.color ?? 'amber';
  const c = NOTE_COLORS[active] ?? NOTE_COLORS.amber;

  useEffect(() => setText(data.text), [data.text]);
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (text !== data.text) updateCommentText(data.id, text);
  };

  const lines = data.text.split('\n');
  const titleIdx = lines.findIndex((l) => l.trim());
  const title = titleIdx >= 0 ? lines[titleIdx].replace(/^#+\s*/, '').trim() : '';
  const body = titleIdx >= 0 ? lines.slice(titleIdx + 1) : [];

  return (
    <div className={`group relative flex h-full w-full flex-col rounded-xl border shadow-md ${c.bg} ${c.border} ${selected ? `ring-2 ${c.ring}` : ''}`}>
      {/* Redimensionable (M64): tira de las esquinas cuando está seleccionada. `onResize` la agranda EN VIVO
          (como el arrastre de posición) y `onResizeEnd` confirma el tamaño como comando deshacible (⌘Z). */}
      <NodeResizer
        isVisible={selected}
        minWidth={180}
        minHeight={72}
        lineClassName="!border-primary/40"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border-2 !border-white/70 !bg-primary"
        onResizeStart={(_, p) => {
          resizeStart.current = { width: Math.round(p.width), height: Math.round(p.height) };
        }}
        onResize={(_, p) => setSizeLive(data.id, Math.round(p.width), Math.round(p.height))}
        onResizeEnd={(_, p) => setSize(data.id, resizeStart.current, { width: Math.round(p.width), height: Math.round(p.height) })}
      />
      {/* Barra flotante (M60): al pasar el cursor o seleccionar. `pb-1.5` sobre `bottom-full` hace de puente
          SIN hueco entre la nota y la barra (mismo patrón que AfNode) → no parpadea al ir a pulsarla. */}
      {!editing && (
        <div className={`nodrag absolute bottom-full left-0 pb-1.5 ${selected ? 'block' : 'hidden group-hover:block'}`}>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-elevated px-1.5 py-1 shadow-lg">
            {COLOR_KEYS.map((k) => (
              <button
                key={k}
                onClick={() => setColor(data.id, k)}
                aria-label={k}
                className={`h-4 w-4 rounded-full transition-transform hover:scale-110 ${NOTE_COLORS[k].dot} ${active === k ? 'ring-2 ring-white ring-offset-1 ring-offset-elevated' : ''}`}
              />
            ))}
            <div className="mx-0.5 h-4 w-px bg-border" />
            <button
              onClick={() => remove(data.id)}
              aria-label={t('Eliminar')}
              className="flex h-5 w-5 items-center justify-center rounded text-txt-secondary transition-colors hover:bg-danger/15 hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      )}

      {editing ? (
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setText(data.text);
              setEditing(false);
            }
          }}
          rows={Math.max(4, text.split('\n').length + 1)}
          placeholder={t('Escribe tu nota. La 1ª línea es el título; usa «- » para viñetas.')}
          className="nodrag min-h-0 w-full flex-1 resize-none bg-transparent p-3 text-xs leading-relaxed text-white/90 outline-none placeholder:text-white/40"
        />
      ) : (
        <div
          className="min-h-0 flex-1 cursor-text overflow-auto p-3 text-xs leading-relaxed text-white/85"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {title && <div className="mb-1.5 text-sm font-semibold text-white">{title}</div>}
          {body.length > 0 && <div className="space-y-1">{renderBody(body)}</div>}
          {!title && body.length === 0 && <span className="text-white/40">{t('Doble clic para escribir…')}</span>}
        </div>
      )}
    </div>
  );
}
