import {
  LayoutDashboard,
  Workflow,
  Bot,
  Activity,
  BarChart3,
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
  /** M84: solo para administradores de PLATAFORMA. No es un rol del workspace, así que va aparte. */
  platformAdmin?: true;
}

// Etiquetas orientadas a TAREA, no a jerga técnica (M16). Están en español (clave i18n): los sitios de
// render (Sidebar, Topbar, CommandPalette) las envuelven con t() para traducir al inglés.
export const NAV: NavItem[] = [
  { to: '/', label: 'Inicio', icon: LayoutDashboard },
  { to: '/workflows', label: 'Automatizaciones', icon: Workflow },
  { to: '/agents', label: 'Trabajadores', icon: Bot },
  { to: '/executions', label: 'Historial', icon: Activity },
  { to: '/marketplace', label: 'Marketplace', icon: Store },
  { to: '/integrations', label: 'Conexiones', icon: Plug },
  { to: '/team', label: 'Equipo', icon: Users, roles: ['OWNER', 'ADMIN'] },
  { to: '/analytics', label: 'Analítica', icon: BarChart3, platformAdmin: true },
  { to: '/settings', label: 'Ajustes', icon: Settings },
];

/**
 * Ítems de nav visibles: oculta los restringidos por rol de workspace (p. ej. «Equipo» a quien no es
 * OWNER/ADMIN) y los de plataforma (M84: «Analítica»).
 *
 * `platformAdmin` va por separado del rol a propósito: no es un rol del workspace, sino una propiedad de
 * la persona que responde `GET /insights/me`. Por defecto es `false` —lo que no se sabe, no se enseña—,
 * y en cualquier caso esto solo decide qué se PINTA: quien escriba la URL a mano se choca con el guard
 * del servidor igual.
 */
export function visibleNav(role: string | null, platformAdmin = false): NavItem[] {
  return NAV.filter(
    (n) => (!n.roles || (role != null && (n.roles as string[]).includes(role))) && (!n.platformAdmin || platformAdmin),
  );
}
