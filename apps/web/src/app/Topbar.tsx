import { useLocation } from 'react-router-dom';
import { Search, Sun, Moon, Bell } from 'lucide-react';
import { NAV } from './nav';
import { useUI } from './ui-store';
import { IconButton } from '../ui';

function titleFor(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  const seg = '/' + pathname.split('/')[1];
  return NAV.find((n) => n.to === seg)?.label ?? 'AgentFlow';
}

export function Topbar() {
  const { pathname } = useLocation();
  const theme = useUI((s) => s.theme);
  const toggleTheme = useUI((s) => s.toggleTheme);
  const setCmdOpen = useUI((s) => s.setCmdOpen);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface/80 px-5 backdrop-blur">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-txt-secondary">AgentFlow</span>
        <span className="text-txt-disabled">/</span>
        <span className="font-medium text-txt-primary">{titleFor(pathname)}</span>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setCmdOpen(true)}
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-txt-secondary transition-colors hover:border-border-strong hover:text-txt-primary"
        >
          <Search size={14} />
          <span className="hidden sm:inline">Buscar acciones…</span>
          <span className="rounded border border-border bg-elevated px-1 font-mono text-[10px]">⌘K</span>
        </button>
        <IconButton aria-label="Notificaciones">
          <Bell size={17} />
        </IconButton>
        <IconButton onClick={toggleTheme} aria-label="Cambiar tema">
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </IconButton>
        <div className="ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-xs font-semibold text-white">
          MS
        </div>
      </div>
    </header>
  );
}
