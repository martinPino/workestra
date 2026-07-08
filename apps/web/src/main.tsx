import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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
import { Integrations } from './pages/Integrations';
import { SettingsPage } from './pages/Settings';
import { Login, Register } from './pages/Auth';
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
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
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
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
});
