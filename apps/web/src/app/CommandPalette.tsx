import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Search, CornerDownLeft, Sun, Moon, Plus } from 'lucide-react';
import { visibleNav } from './nav';
import { useAuth } from '../lib/auth';
import { useUI } from './ui-store';
import { cn } from '../lib/cn';
import { useT } from '../i18n';

interface Action {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const open = useUI((s) => s.cmdOpen);
  const setCmdOpen = useUI((s) => s.setCmdOpen);
  const toggleTheme = useUI((s) => s.toggleTheme);
  const theme = useUI((s) => s.theme);
  const t = useT();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  // Atajo global ⌘K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen(!useUI.getState().cmdOpen);
      }
      if (e.key === 'Escape') setCmdOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setCmdOpen]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open]);

  const role = useAuth((s) => s.role);
  const actions: Action[] = useMemo(() => {
    const nav: Action[] = visibleNav(role).map((n) => ({
      id: `nav-${n.to}`,
      label: `${t('Ir a')} ${t(n.label)}`,
      hint: t('Navegación'),
      icon: <n.icon size={16} />,
      run: () => navigate(n.to),
    }));
    return [
      { id: 'new-wf', label: t('Nuevo workflow'), hint: t('Acción'), icon: <Plus size={16} />, run: () => navigate('/workflows?new=1') },
      {
        id: 'theme',
        label: `${t('Cambiar a tema')} ${theme === 'dark' ? t('claro') : t('oscuro')}`,
        hint: t('Acción'),
        icon: theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />,
        run: toggleTheme,
      },
      ...nav,
    ];
  }, [navigate, theme, toggleTheme, t, role]);

  const filtered = useMemo(
    () => actions.filter((a) => a.label.toLowerCase().includes(query.toLowerCase())),
    [actions, query],
  );

  const exec = (a?: Action) => {
    if (!a) return;
    a.run();
    setCmdOpen(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setCmdOpen(false)} />
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -8 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border glass shadow-pop"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                exec(filtered[cursor]);
              }
            }}
          >
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search size={18} className="text-txt-secondary" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                placeholder={t('Escribe un comando o busca…')}
                className="h-12 w-full bg-transparent text-sm text-txt-primary placeholder:text-txt-disabled outline-none"
              />
              <span className="rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-txt-secondary">
                esc
              </span>
            </div>
            <div className="max-h-80 overflow-y-auto p-2">
              {filtered.length === 0 && (
                <div className="px-3 py-8 text-center text-sm text-txt-secondary">{t('Sin resultados')}</div>
              )}
              {filtered.map((a, i) => (
                <button
                  key={a.id}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => exec(a)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                    i === cursor ? 'bg-elevated text-txt-primary' : 'text-txt-secondary',
                  )}
                >
                  <span className="text-txt-secondary">{a.icon}</span>
                  <span className="flex-1">{a.label}</span>
                  {a.hint && <span className="text-[10px] text-txt-disabled">{a.hint}</span>}
                  {i === cursor && <CornerDownLeft size={13} className="text-txt-disabled" />}
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
