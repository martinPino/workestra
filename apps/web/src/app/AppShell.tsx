import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { CommandPalette } from './CommandPalette';

export function AppShell() {
  return (
    <div className="flex h-screen overflow-hidden bg-bg text-txt-primary">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}

export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={`mx-auto max-w-[1400px] px-4 py-4 sm:px-6 sm:py-6 ${className ?? ''}`}>{children}</div>
    </div>
  );
}
