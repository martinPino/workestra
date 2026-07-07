import { useEffect, useRef, useState } from 'react';
import { Sparkles, X, ArrowUp } from 'lucide-react';
import { IconButton } from '../ui';
import { useEditorStore } from '../editor/store';
import { docToWorkflowGraph, workflowGraphToDoc } from '../graph';
import { ThinkingSteps } from './ThinkingSteps';
import { ModelKeysDialog } from './ModelKeysDialog';
import { api } from '../lib/api';
import { GENERATION_MODELS, DEFAULT_GENERATION_MODEL } from '../lib/models';
import { useT } from '../i18n';

type Msg = { role: 'user' | 'ai'; text: string };

/**
 * Chat de IA en el editor, consciente del contexto (M30 · M36). El usuario está VIENDO un flujo en el lienzo
 * y conversa: puede pedir un cambio («añade un Slack al final») o hacer una PREGUNTA sobre el flujo («¿qué
 * hace esto?»). Cada mensaje envía el CONTEXTO COMPLETO del flujo — grafo actual + nombre + notas del lienzo +
 * nodo seleccionado — y la IA decide: editar el flujo (lo aplicamos, reversible con ⌘Z) o responder en texto.
 */
export function AiChatPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [messages, setMessages] = useState<Msg[]>([
    { role: 'ai', text: t('Pregúntame sobre este flujo o dime qué cambiar. Ej.: «¿qué hace este flujo?» o «añade un aviso a Slack al final».') },
  ]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState(DEFAULT_GENERATION_MODEL); // M34: modelo elegido para el chat de IA
  const [keysOpen, setKeysOpen] = useState(false); // M35: «usa tu propia clave»
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: message }]);
    setBusy(true);
    try {
      // Damos a la IA TODO el contexto del flujo que el usuario está viendo, no solo los nodos:
      const st = useEditorStore.getState();
      const doc = st.history.doc;
      const current = docToWorkflowGraph(doc);
      const notes = doc.comments.map((c) => c.text).filter((s) => s.trim()); // notas pegadas en el lienzo
      const selected = st.selection[0]; // key del nodo que tiene seleccionado (o undefined)
      const res = await api.chatWorkflow(current, message, { name: st.workflowName, notes, selected, model, page: 'editor' });
      if (res.kind === 'edit') {
        const newDoc = workflowGraphToDoc(res.graph);
        // replaceGraph (no loadDoc): conserva las notas del usuario y es REVERSIBLE con ⌘Z.
        useEditorStore.getState().replaceGraph(newDoc.nodes, newDoc.edges);
        setMessages((m) => [...m, { role: 'ai', text: t('Listo, actualicé el flujo. Pulsa ⌘Z para deshacer.') }]);
      } else {
        // Pregunta: la IA respondió con texto usando el contexto del flujo; no tocamos el lienzo.
        setMessages((m) => [...m, { role: 'ai', text: res.text }]);
      }
    } catch (e) {
      // Muestra el motivo real del backend (p. ej. «descripción demasiado larga») en vez de un genérico.
      const detail = e instanceof Error ? (e.message.match(/^HTTP \d+:\s*(.+)/)?.[1] ?? '') : '';
      setMessages((m) => [...m, { role: 'ai', text: detail ? `${t('No pude responder.')} ${detail}` : t('No pude responder. Prueba a decirlo de otra forma.') }]);
      setInput(message); // no perder el texto si falló
    } finally {
      setBusy(false);
    }
  };

  const suggestions = [t('¿Qué hace este flujo?'), t('Añade un aviso a Slack al final'), t('¿Cómo puedo mejorarlo?')];

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
          <div className="flex justify-start">
            <div className="w-full max-w-[92%] space-y-2">
              <p className="px-1 text-[11px] leading-relaxed text-txt-secondary">
                {t('Voy a aplicar tu cambio: analizo el flujo y ajusto los nodos.')}
              </p>
              <ThinkingSteps />
            </div>
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
        <div className="mb-2 flex items-center gap-2">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label={t('Modelo de IA')}
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] text-txt-secondary outline-none focus:border-primary/60"
          >
            {GENERATION_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setKeysOpen(true)} className="shrink-0 text-[11px] font-medium text-primary hover:underline">
            {t('Usa tu clave')}
          </button>
        </div>
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
      {keysOpen && <ModelKeysDialog onClose={() => setKeysOpen(false)} />}
    </aside>
  );
}
