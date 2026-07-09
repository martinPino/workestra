import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
import { PanelLeftClose, PanelLeft, Command } from 'lucide-react';
import { visibleNav } from './nav';
import { useUI } from './ui-store';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useT } from '../i18n';

export function Sidebar() {
  const t = useT();
  const role = useAuth((s) => s.role);
  const collapsed = useUI((s) => s.collapsed);
  const toggleCollapsed = useUI((s) => s.toggleCollapsed);
  const mobileNav = useUI((s) => s.mobileNav);
  const setMobileNav = useUI((s) => s.setMobileNav);
  const setCmdOpen = useUI((s) => s.setCmdOpen);
  const isDesktop = useMediaQuery('(min-width: 768px)');

  // El colapso (icono-only) es SOLO de desktop; en móvil el drawer va siempre expandido.
  const collapsedEff = isDesktop && collapsed;

  return (
    <>
      {/* Backdrop del drawer en móvil */}
      {mobileNav && !isDesktop && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMobileNav(false)} aria-hidden />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[236px] shrink-0 flex-col border-r border-border bg-surface transition-all duration-200',
          'md:relative md:z-20',
          mobileNav ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
          collapsedEff ? 'md:w-16' : 'md:w-[236px]',
        )}
      >
        {/* Marca */}
        <div className={cn('flex h-14 items-center gap-2.5 px-4', collapsedEff && 'justify-center px-0')}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg brand-gradient shadow-glow">
            <span className="text-sm font-bold text-white">A</span>
          </div>
          {!collapsedEff && (
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight text-txt-primary">AgentFlow</div>
              <div className="text-[10px] text-txt-secondary">Agent Orchestration</div>
            </div>
          )}
        </div>

        {/* Buscar / ⌘K */}
        <div className={cn('px-3', collapsedEff && 'px-2')}>
          <button
            onClick={() => setCmdOpen(true)}
            className={cn(
              'group flex w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-txt-secondary transition-colors hover:border-border-strong hover:text-txt-primary',
              collapsedEff && 'justify-center px-0',
            )}
          >
            <Command size={14} />
            {!collapsedEff && (
              <>
                <span className="flex-1 text-left">{t('Buscar…')}</span>
                <span className="rounded border border-border bg-elevated px-1 font-mono text-[10px]">⌘K</span>
              </>
            )}
          </button>
        </div>

        {/* Navegación */}
        <nav className="mt-3 flex-1 space-y-0.5 px-3">
          {visibleNav(role).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={() => setMobileNav(false)}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                  collapsedEff && 'justify-center px-0',
                  isActive ? 'text-txt-primary' : 'text-txt-secondary hover:bg-elevated hover:text-txt-primary',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-0 rounded-lg bg-elevated"
                      transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                    />
                  )}
                  <item.icon size={18} className={cn('relative shrink-0', isActive && 'text-primary')} />
                  {!collapsedEff && <span className="relative">{t(item.label)}</span>}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Footer — colapsar (solo útil en desktop) */}
        <div className="hidden border-t border-border p-3 md:block">
          <button
            onClick={toggleCollapsed}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-txt-secondary transition-colors hover:bg-elevated hover:text-txt-primary',
              collapsedEff && 'justify-center px-0',
            )}
          >
            {collapsedEff ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
            {!collapsedEff && <span>{t('Colapsar')}</span>}
          </button>
        </div>
      </aside>
    </>
  );
}
