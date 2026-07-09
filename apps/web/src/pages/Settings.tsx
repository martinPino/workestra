import { useState } from 'react';
import { Moon, Sun, Monitor, Bell, KeyRound, Building2, ShieldCheck, LogOut } from 'lucide-react';
import { Page } from '../app/AppShell';
import { Card, PageHeader, Switch, Input, Button, Badge } from '../ui';
import { useUI } from '../app/ui-store';
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import { useAuth, canApprove, useCan, AUTH_MODE, type Role } from '../lib/auth';
import { useT } from '../i18n';

const ROLES: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'];

/** Decodifica el `sub` de un JWT (sin verificar; solo para mostrar quién resuelve). */
function jwtSub(token: string): string {
  try {
    return JSON.parse(atob(token.split('.')[1])).sub ?? 'dev';
  } catch {
    return 'dev';
  }
}

function SessionCard() {
  const t = useT();
  const { token, role, setSession, clear } = useAuth();
  const [picked, setPicked] = useState<Role>(role ?? 'EDITOR');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { accessToken } = await api.devToken(picked);
      setSession({ token: accessToken, role: picked, sub: jwtSub(accessToken) });
    } catch {
      setErr(t('No se pudo emitir el token (¿API arriba?)'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      icon={<ShieldCheck size={16} />}
      title={t('Sesión (dev) · Escalado humano')}
      description={t('Emite un JWT de desarrollo para aprobar/rechazar revisiones. Aprobar exige el scope execution:approve (OWNER/ADMIN/EDITOR).')}
    >
      <div className="flex flex-wrap items-center gap-2">
        {ROLES.map((r) => (
          <button
            key={r}
            onClick={() => setPicked(r)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
              picked === r ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-txt-secondary hover:text-txt-primary',
            )}
          >
            {r}
          </button>
        ))}
        <Button size="sm" variant="primary" onClick={generate} disabled={busy}>
          {busy ? t('Emitiendo…') : t('Generar token')}
        </Button>
      </div>
      <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          {token ? (
            <>
              <Badge tone={canApprove(role) ? 'success' : 'warning'}>{role}</Badge>
              <span className="text-txt-secondary">{t('sesión activa')}</span>
              <span className="font-mono text-[11px] text-txt-disabled">…{token.slice(-10)}</span>
            </>
          ) : (
            <span className="text-txt-secondary">{t('Sin sesión — genera un token para poder aprobar revisiones.')}</span>
          )}
        </div>
        {token && (
          <button onClick={clear} className="flex items-center gap-1 text-xs text-txt-secondary hover:text-danger">
            <LogOut size={13} /> {t('Salir')}
          </button>
        )}
      </div>
      {err && <p className="text-xs text-danger">{err}</p>}
    </Section>
  );
}

export function SettingsPage() {
  const t = useT();
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const canManageKeys = useCan('apikey:manage');

  return (
    <Page className="max-w-3xl space-y-6">
      <PageHeader title={t('Configuración')} subtitle={t('Apariencia, notificaciones y preferencias de la cuenta.')} />

      {/* El minter de tokens de dev solo tiene sentido en modo 'dev'; con auth real (login) se oculta. */}
      {AUTH_MODE === 'dev' && <SessionCard />}

      <Section icon={<Monitor size={16} />} title={t('Apariencia')} description={t('Personaliza cómo se ve AgentFlow.')}>
        <div className="flex gap-2">
          {(
            [
              { key: 'dark', label: t('Oscuro'), icon: <Moon size={15} /> },
              { key: 'light', label: t('Claro'), icon: <Sun size={15} /> },
            ] as const
          ).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setTheme(opt.key)}
              className={cn(
                'flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium transition-colors',
                theme === opt.key ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-txt-secondary hover:text-txt-primary',
              )}
            >
              {opt.icon} {opt.label}
            </button>
          ))}
        </div>
      </Section>

      <Section icon={<Bell size={16} />} title={t('Notificaciones')} description={t('Cuándo quieres recibir avisos.')}>
        <Row label={t('Ejecución completada')} desc={t('Notificar al finalizar un workflow')} defaultOn />
        <Row label={t('Ejecución fallida')} desc={t('Avisar ante errores o timeouts')} defaultOn />
        <Row label={t('Escalado humano')} desc={t('Cuando un agente pide aprobación')} />
      </Section>

      <Section icon={<Building2 size={16} />} title={t('Workspace')} description={t('Identidad de tu espacio de trabajo.')}>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-txt-secondary">{t('Nombre del workspace')}</span>
          <Input defaultValue="Default" />
        </label>
      </Section>

      <Section icon={<KeyRound size={16} />} title={t('Proveedores LLM')} description={t('Claves de API (cifradas por el Secret Manager).')}>
        {canManageKeys ? (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-txt-secondary">Anthropic API Key</span>
            <Input type="password" placeholder={t('sk-ant-… (usa el Mock si está vacía)')} />
          </label>
        ) : (
          <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
            <div>
              <div className="text-sm text-txt-primary">Anthropic</div>
              <div className="text-xs text-txt-secondary">{t('Configurado por un administrador del workspace.')}</div>
            </div>
            <span className="font-mono text-[11px] text-txt-disabled">sk-ant-••••••••</span>
          </div>
        )}
      </Section>
    </Page>
  );
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-elevated text-txt-secondary">{icon}</div>
        <div>
          <div className="text-sm font-semibold text-txt-primary">{title}</div>
          <div className="text-xs text-txt-secondary">{description}</div>
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </Card>
  );
}

function Row({ label, desc, defaultOn }: { label: string; desc: string; defaultOn?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
      <div>
        <div className="text-sm text-txt-primary">{label}</div>
        <div className="text-xs text-txt-secondary">{desc}</div>
      </div>
      <ToggleRow defaultOn={defaultOn} />
    </div>
  );
}

function ToggleRow({ defaultOn }: { defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn ?? false);
  return <Switch checked={on} onChange={setOn} />;
}
