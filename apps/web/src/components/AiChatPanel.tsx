import { useEffect, useRef, useState } from 'react';
import { Sparkles, X, ArrowUp, Loader2 } from 'lucide-react';
import { IconButton } from '../ui';
import { useEditorStore } from '../editor/store';
import { docToWorkflowGraph, workflowGraphToDoc } from '../graph';
import { api } from '../lib/api';
import { useT } from '../i18n';

type Msg = { role: 'user' | 'ai'; text: string };

/**
 * Chat de IA en el editor (M30): el usuario sigue modificando el flujo conversando («añade un Slack al
 * final», «cambia el trigger a cada mañana»). Cada mensaje envía el GRAFO ACTUAL + la instrucción al backend,
 * que devuelve el grafo modificado; lo cargamos con `loadDoc` (el autoguardado del editor lo persiste).
 */
export function AiChatPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [messages, setMessages] = useState<Msg[]>([{ role: 'ai', text: t('Dime qué quieres cambiar en el flujo y lo hago. Ej.: «añade un aviso a Slack al final».') }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (text: string) => {
    const instruction = text.trim();
    if (!instruction || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: instruction }]);
    setBusy(true);
    try {
      // El grafo ES el estado: mandamos el actual + la instrucción, sin arrastrar historial de chat.
      const current = docToWorkflowGraph(useEditorStore.getState().history.doc);
      const { graph } = await api.editWorkflowGraph(current, instruction);
      const newDoc = workflowGraphToDoc(graph);
      // replaceGraph (no loadDoc): conserva las notas del usuario y es REVERSIBLE con ⌘Z.
      useEditorStore.getState().replaceGraph(newDoc.nodes, newDoc.edges);
      setMessages((m) => [...m, { role: 'ai', text: t('Listo, actualicé el flujo. Pulsa ⌘Z para deshacer.') }]);
    } catch (e) {
      // Muestra el motivo real del backend (p. ej. «descripción demasiado larga») en vez de un genérico.
      const detail = e instanceof Error ? (e.message.match(/^HTTP \d+:\s*(.+)/)?.[1] ?? '') : '';
      setMessages((m) => [...m, { role: 'ai', text: detail ? `${t('No pude aplicar ese cambio.')} ${detail}` : t('No pude aplicar ese cambio. Prueba a decirlo de otra forma.') }]);
      setInput(instruction); // no perder el texto si falló
    } finally {
      setBusy(false);
    }
  };

  const suggestions = [t('Añade un aviso a Slack al final'), t('Cambia el disparador a cada mañana'), t('Añade un paso que resuma con IA')];

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-full max-w-sm flex-col border-l border-border bg-surface md:static md:z-0 md:w-96 md:max-w-none">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/12 text-primary">
            <Sparkles size={13} />
          </span>
          <span className="text-xs font-semibold text-txt-primary">{t('Asistente de IA')}</span>
        </div>
        <IconButton aria-label={t('Cerrar')} onClick={onClose}>
          <X size={15} />
        </IconButton>
      </div>

      <div ref={scrollRef} aria-live="polite" className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={
                m.role === 'user'
                  ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-primary/15 px-3 py-2 text-xs text-txt-primary'
                  : 'max-w-[85%] rounded-2xl rounded-bl-sm border border-border bg-elevated px-3 py-2 text-xs text-txt-secondary'
              }
            >
              {m.text}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 px-1 text-[11px] text-txt-disabled">
            <Loader2 size={12} className="animate-spin" /> {t('Actualizando el flujo…')}
          </div>
        )}
        {messages.length <= 1 && !busy && (
          <div className="flex flex-col items-start gap-1.5 pt-1">
            {suggestions.map((sug) => (
              <button
                key={sug}
                onClick={() => send(sug)}
                className="rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] text-txt-secondary hover:border-border-strong hover:text-txt-primary"
              >
                {sug}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border p-2.5">
        <div className="flex items-end gap-2 rounded-xl border border-border bg-surface p-1.5 focus-within:border-primary/60">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder={t('Escribe un cambio…')}
            aria-label={t('Instrucción para la IA')}
            className="max-h-28 min-h-[24px] flex-1 resize-none bg-transparent px-1.5 py-1 text-xs text-txt-primary outline-none placeholder:text-txt-disabled"
          />
          <IconButton aria-label={t('Enviar')} disabled={busy || !input.trim()} onClick={() => send(input)} className="bg-primary/15 text-primary hover:bg-primary/25">
            <ArrowUp size={15} />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}
