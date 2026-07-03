import { useState, useEffect } from 'react';
import type { NodeProps } from 'reactflow';
import { X } from 'lucide-react';
import type { CommentNodeData } from '../graph';
import { useEditorStore } from '../editor/store';

/** Comentario/anotación tipo sticky note. Se edita en el nodo y se confirma al perder foco. */
export function CommentNode({ data, selected }: NodeProps<CommentNodeData>) {
  const [text, setText] = useState(data.text);
  const updateCommentText = useEditorStore((s) => s.updateCommentText);
  const removeCommentById = useEditorStore((s) => s.removeCommentById);

  useEffect(() => setText(data.text), [data.text]);

  return (
    <div
      className={`min-h-[64px] w-[184px] rounded-xl border border-warning/40 bg-warning/[0.07] p-2.5 text-xs text-txt-primary ${selected ? 'ring-2 ring-warning' : ''}`}
    >
      <div className="mb-1 flex items-center justify-between text-[10px] text-warning">
        <span>Comentario</span>
        <button onClick={() => removeCommentById(data.id)} className="opacity-70 hover:opacity-100">
          <X size={12} />
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== data.text && updateCommentText(data.id, text)}
        className="w-full resize-none bg-transparent text-xs text-txt-primary outline-none placeholder:text-txt-disabled"
        rows={2}
      />
    </div>
  );
}
