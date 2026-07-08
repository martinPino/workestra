import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
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
import { ensureDevSession } from './lib/auth';
import { api } from './lib/api';
import './index.css';

initTheme();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

// Garantiza una sesión autenticada ANTES de renderizar (el backend exige JWT en M8). En producción
// esto lo sustituye el login OIDC; en dev acuña un token OWNER (o re-acuña uno caducado).
void ensureDevSession(api.base).finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
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
