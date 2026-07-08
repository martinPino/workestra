import { useEffect, useRef, useState } from 'react';
import { Sparkles, X, ArrowUp } from 'lucide-react';
import { IconButton } from '../ui';
import { ThinkingSteps } from './ThinkingSteps';
import { ModelKeysDialog } from './ModelKeysDialog';
import { api, type AgentDraft } from '../lib/api';
import { GENERATION_MODELS, DEFAULT_GENERATION_MODEL } from '../lib/models';
import { useT } from '../i18n';

type Msg = { role: 'user' | 'ai'; text: string };

/**
 * Chat de la página Asistentes (M68): la persona describe en sus palabras el asistente que quiere y la IA
 * prepara un borrador (rol, objetivo, instrucciones, modelo, herramientas). El borrador RELLENA el
 * formulario «Nuevo agente» (vía `onDraft`) para que la persona lo revise y pulse «Crear». Si solo pregunta,
 * responde en texto. Widget flotante en la esquina, hermano de la burbuja (mismo patrón que el chat del editor).
 */
export function AgentChatPanel({ onClose, onDraft }: { onClose: () => void; onDraft: (draft: AgentDraft) => void }) {
  const t = useT();
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'ai',
      text: t(
        'Describe el asistente que quieres crear y te preparo el borrador. Ej.: «un investigador que resuma noticias de IA con fuentes» o «un agente de soporte al cliente en español».',
      ),
    },
  ]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState(DEFAULT_GENERATION_MODEL);
  const [keysOpen, setKeysOpen] = useState(false);
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
      const res = await api.chatAgent(message, { model });
      if (res.kind === 'create') {
        onDraft(res.agent); // rellena el formulario «Nuevo agente» para revisar y confirmar
        setMessages((m) => [
          ...m,
          { role: 'ai', text: t('Te preparé el borrador de «{name}». Revísalo en el formulario y pulsa «Crear agente».').replace('{name}', res.agent.name) },
        ]);
      } else {
        setMessages((m) => [...m, { role: 'ai', text: res.text }]);
      }
    } catch (e) {
      const detail = e instanceof Error ? (e.message.match(/^HTTP \d+:\s*(.+)/)?.[1] ?? '') : '';
      setMessages((m) => [...m, { role: 'ai', text: detail ? `${t('No pude crearlo.')} ${detail}` : t('No pude crearlo. Prueba a describirlo de otra forma.') }]);
      setInput(message); // no perder el texto si falló
    } finally {
      setBusy(false);
    }
  };

  const suggestions = [
    t('Un investigador que resuma noticias con fuentes'),
    t('Un agente de soporte al cliente en español'),
    t('Un coordinador que planifique y delegue'),
  ];

  return (
    <aside className="fixed bottom-6 right-6 z-40 flex h-[560px] max-h-[calc(100vh-6rem)] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-pop">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/12 text-primary">
            <Sparkles size={13} />
          </span>
          <span className="text-xs font-semibold text-txt-primary">{t('Crear asistente con IA')}</span>
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
                {t('Estoy diseñando tu asistente: su rol, objetivo e instrucciones.')}
              </p>
              <ThinkingSteps
                steps={[t('Entendiendo lo que necesitas'), t('Definiendo su rol y objetivo'), t('Redactando sus instrucciones'), t('Eligiendo modelo y herramientas')]}
              />
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
            placeholder={t('Describe el asistente…')}
            aria-label={t('Descripción del asistente para la IA')}
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
