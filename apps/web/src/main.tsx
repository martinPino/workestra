import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AnalyticsProvider } from './analytics/provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './app/AppShell';
import { initTheme } from './app/ui-store';
import { Dashboard } from './pages/Dashboard';
import { Workflows } from './pages/Workflows';
import { Editor } from './pages/Editor';
import { Agents } from './pages/Agents';
import { Executions } from './pages/Executions';
import { ExecutionDetail } from './pages/ExecutionDetail';
import { Marketplace } from './pages/Marketplace';
import { MarketplaceDetail } from './pages/MarketplaceDetail';
import { Integrations } from './pages/Integrations';
import { SettingsPage } from './pages/Settings';
import { Team } from './pages/Team';
import { Analytics } from './pages/Analytics';
import { Login, Register } from './pages/Auth';
import { AcceptInvite } from './pages/AcceptInvite';
import { ensureDevSession, useAuth, isExpired } from './lib/auth';
import { api } from './lib/api';
import './index.css';

initTheme();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

/**
 * Guarda de rutas (M73): exige una sesión válida para entrar a la app. Suscrita al store para reaccionar
 * a login/logout/expiración. Sin sesión → redirige a /login. En modo 'dev' el arranque ya acuñó un token,
 * así que esta guarda pasa sola.
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuth((s) => s.token);
  if (!token || isExpired(token)) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// En 'dev' garantiza una sesión ANTES de renderizar (auto-login del minter). En 'local' es un no-op y la
// app renderiza directa: la ProtectedRoute mandará a /login si no hay sesión.
void ensureDevSession(api.base).finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          {/* Dentro del router a propósito: la captura automática necesita saber en qué ruta está. */}
          <AnalyticsProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/invite/:token" element={<AcceptInvite />} />
            <Route
              element={
                <ProtectedRoute>
                  <AppShell />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<Dashboard />} />
              <Route path="/workflows" element={<Workflows />} />
              <Route path="/workflows/:id" element={<Editor />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/executions" element={<Executions />} />
              <Route path="/executions/:id" element={<ExecutionDetail />} />
              <Route path="/marketplace" element={<Marketplace />} />
              <Route path="/marketplace/:id" element={<MarketplaceDetail />} />
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/team" element={<Team />} />
              {/* M84. Sin guard de cliente a propósito: el permiso lo decide la API (403), y una guarda
                  aquí solo repetiría —peor y más tarde— una decisión que ya es del servidor. */}
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Routes>
          </AnalyticsProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
});
