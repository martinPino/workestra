import {
  LayoutDashboard,
  Workflow,
  Bot,
  Activity,
  Store,
  Plug,
  Users,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Si está, el ítem solo se muestra a estos roles (M74: «Equipo» solo para OWNER/ADMIN). */
  roles?: Array<'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER'>;
}

// Etiquetas orientadas a TAREA, no a jerga técnica (M16). Están en español (clave i18n): los sitios de
// render (Sidebar, Topbar, CommandPalette) las envuelven con t() para traducir al inglés.
export const NAV: NavItem[] = [
  { to: '/', label: 'Inicio', icon: LayoutDashboard },
  { to: '/workflows', label: 'Automatizaciones', icon: Workflow },
  { to: '/agents', label: 'Asistentes', icon: Bot },
  { to: '/executions', label: 'Historial', icon: Activity },
  { to: '/marketplace', label: 'Marketplace', icon: Store },
  { to: '/integrations', label: 'Conexiones', icon: Plug },
  { to: '/team', label: 'Equipo', icon: Users, roles: ['OWNER', 'ADMIN'] },
  { to: '/settings', label: 'Ajustes', icon: Settings },
];

/** Ítems de nav visibles para un rol: oculta los restringidos (p. ej. «Equipo» a quien no es OWNER/ADMIN). */
export function visibleNav(role: string | null): NavItem[] {
  return NAV.filter((n) => !n.roles || (role != null && (n.roles as string[]).includes(role)));
}
