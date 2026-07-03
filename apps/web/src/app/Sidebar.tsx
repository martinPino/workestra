import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
import { PanelLeftClose, PanelLeft, Command } from 'lucide-react';
import { NAV } from './nav';
import { useUI } from './ui-store';
import { cn } from '../lib/cn';
import { useT } from '../i18n';

export function Sidebar() {
  const t = useT();
  const collapsed = useUI((s) => s.collapsed);
  const toggleCollapsed = useUI((s) => s.toggleCollapsed);
  const setCmdOpen = useUI((s) => s.setCmdOpen);

  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 236 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      className="relative z-20 flex shrink-0 flex-col border-r border-border bg-surface"
    >
      {/* Marca */}
      <div className={cn('flex h-14 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg brand-gradient shadow-glow">
          <span className="text-sm font-bold text-white">A</span>
        </div>
        {!collapsed && (
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight text-txt-primary">AgentFlow</div>
            <div className="text-[10px] text-txt-secondary">Agent Orchestration</div>
          </div>
        )}
      </div>

      {/* Buscar / ⌘K */}
      <div className={cn('px-3', collapsed && 'px-2')}>
        <button
          onClick={() => setCmdOpen(true)}
          className={cn(
            'group flex w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-txt-secondary transition-colors hover:border-border-strong hover:text-txt-primary',
            collapsed && 'justify-center px-0',
          )}
        >
          <Command size={14} />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">{t('Buscar…')}</span>
              <span className="rounded border border-border bg-elevated px-1 font-mono text-[10px]">⌘K</span>
            </>
          )}
        </button>
      </div>

      {/* Navegación */}
      <nav className="mt-3 flex-1 space-y-0.5 px-3">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                collapsed && 'justify-center px-0',
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
                {!collapsed && <span className="relative">{item.label}</span>}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-border p-3">
        <button
          onClick={toggleCollapsed}
          className={cn(
            'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-txt-secondary transition-colors hover:bg-elevated hover:text-txt-primary',
            collapsed && 'justify-center px-0',
          )}
        >
          {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
          {!collapsed && <span>{t('Colapsar')}</span>}
        </button>
      </div>
    </motion.aside>
  );
}
