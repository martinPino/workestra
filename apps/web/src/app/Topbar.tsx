import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Sun, Moon, Bell, Menu, LogOut } from 'lucide-react';
import { NAV } from './nav';
import { useUI, type Lang } from './ui-store';
import { IconButton } from '../ui';
import { useAuth } from '../lib/auth';
import { useT } from '../i18n';

/** Iniciales para el avatar: dos primeras iniciales del nombre, o del email. */
function initialsOf(name?: string | null, email?: string | null): string {
  const src = (name || email || 'U').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/** Avatar + menú de usuario (M73): muestra nombre/email y permite cerrar sesión. */
function UserMenu() {
  const t = useT();
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const sub = useAuth((s) => s.sub);
  const clear = useAuth((s) => s.clear);
  const [open, setOpen] = useState(false);
  const initials = initialsOf(user?.name, user?.email ?? sub);
  const logout = () => {
    clear();
    setOpen(false);
    navigate('/login', { replace: true });
  };
  return (
    <div className="relative ml-1">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={user?.name ?? user?.email ?? t('Cuenta')}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-xs font-semibold text-white transition-shadow hover:shadow-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        {initials}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-56 rounded-lg border border-border bg-elevated p-1 shadow-pop">
            <div className="px-3 py-2">
              <div className="truncate text-xs font-medium text-txt-primary">{user?.name ?? t('Cuenta')}</div>
              <div className="truncate text-[11px] text-txt-disabled">{user?.email ?? sub ?? ''}</div>
            </div>
            <div className="my-1 h-px bg-border" />
            <button
              onClick={logout}
              className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-txt-secondary transition-colors hover:bg-card hover:text-danger"
            >
              <LogOut size={13} /> {t('Cerrar sesión')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Devuelve la etiqueta de nav (en español, clave i18n) de la ruta actual; se traduce con t() al render. */
function titleFor(pathname: string): string {
  const seg = '/' + pathname.split('/')[1];
  return NAV.find((n) => n.to === seg)?.label ?? 'Workestra';
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
        <span className="hidden text-txt-secondary sm:inline">Workestra</span>
        <span className="hidden text-txt-disabled sm:inline">/</span>
        <span className="truncate font-medium text-txt-primary">{t(titleFor(pathname))}</span>
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
        <UserMenu />
      </div>
    </header>
  );
}
