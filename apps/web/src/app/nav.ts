import {
  LayoutDashboard,
  Workflow,
  Bot,
  Activity,
  Store,
  Plug,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

// Etiquetas orientadas a TAREA, no a jerga técnica (M16). Están en español (clave i18n): los sitios de
// render (Sidebar, Topbar, CommandPalette) las envuelven con t() para traducir al inglés.
export const NAV: NavItem[] = [
  { to: '/', label: 'Inicio', icon: LayoutDashboard },
  { to: '/workflows', label: 'Automatizaciones', icon: Workflow },
  { to: '/agents', label: 'Asistentes', icon: Bot },
  { to: '/executions', label: 'Historial', icon: Activity },
  { to: '/marketplace', label: 'Plantillas', icon: Store },
  { to: '/integrations', label: 'Conexiones', icon: Plug },
  { to: '/settings', label: 'Ajustes', icon: Settings },
];
