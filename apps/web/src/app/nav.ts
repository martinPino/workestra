import {
  LayoutDashboard,
  Workflow,
  Bot,
  Activity,
  Store,
  Wrench,
  Plug,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/executions', label: 'Executions', icon: Activity },
  { to: '/marketplace', label: 'Marketplace', icon: Store },
  { to: '/tools', label: 'Tools', icon: Wrench },
  { to: '/integrations', label: 'Integrations', icon: Plug },
  { to: '/settings', label: 'Settings', icon: Settings },
];
