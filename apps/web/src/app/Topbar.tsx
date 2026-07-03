import { useLocation } from 'react-router-dom';
import { Search, Sun, Moon, Bell, Menu } from 'lucide-react';
import { NAV } from './nav';
import { useUI, type Lang } from './ui-store';
import { IconButton } from '../ui';
import { useT } from '../i18n';

function titleFor(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  const seg = '/' + pathname.split('/')[1];
  return NAV.find((n) => n.to === seg)?.label ?? 'AgentFlow';
}

/** Selector de idioma ES/EN (segmentado) en el header. Persiste en localStorage vía el ui-store. */
function LanguageSelector() {
  const lang = useUI((s) => s.lang);
  const setLang = useUI((s) => s.setLang);
  const opts: Lang[] = ['es', 'en'];
  return (
    <div className="flex items-center rounded-lg border border-border bg-card p-0.5" role="group" aria-label="Language">
      {opts.map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`rounded-md px-2 py-1 text-[11px] font-semibold uppercase transition-colors ${
            lang === l ? 'bg-elevated text-txt-primary' : 'text-txt-secondary hover:text-txt-primary'
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function Topbar() {
  const { pathname } = useLocation();
  const t = useT();
  const theme = useUI((s) => s.theme);
  const toggleTheme = useUI((s) => s.toggleTheme);
  const setCmdOpen = useUI((s) => s.setCmdOpen);
  const setMobileNav = useUI((s) => s.setMobileNav);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface/80 px-3 backdrop-blur sm:px-5">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <IconButton className="md:hidden" aria-label="Menu" onClick={() => setMobileNav(true)}>
          <Menu size={18} />
        </IconButton>
        <span className="hidden text-txt-secondary sm:inline">AgentFlow</span>
        <span className="hidden text-txt-disabled sm:inline">/</span>
        <span className="truncate font-medium text-txt-primary">{titleFor(pathname)}</span>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setCmdOpen(true)}
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-txt-secondary transition-colors hover:border-border-strong hover:text-txt-primary"
        >
          <Search size={14} />
          <span className="hidden sm:inline">{t('Buscar acciones…')}</span>
          <span className="rounded border border-border bg-elevated px-1 font-mono text-[10px]">⌘K</span>
        </button>
        <LanguageSelector />
        <IconButton aria-label={t('Notificaciones')}>
          <Bell size={17} />
        </IconButton>
        <IconButton onClick={toggleTheme} aria-label={t('Cambiar tema')}>
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </IconButton>
        <div className="ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-xs font-semibold text-white">
          MS
        </div>
      </div>
    </header>
  );
}
