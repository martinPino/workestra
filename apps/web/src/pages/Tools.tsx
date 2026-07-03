import { Wrench, Globe, ShieldCheck, ShieldAlert, Lock } from 'lucide-react';
import { Page } from '../app/AppShell';
import { Card, Badge, Dot, PageHeader } from '../ui';
import { useT } from '../i18n';

const ENABLED = [
  { key: 'mock', icon: <Wrench size={18} />, desc: 'Herramienta de eco determinista para pruebas.', scope: 'tool:mock' },
  { key: 'http', icon: <Globe size={18} />, desc: 'Peticiones HTTP restringidas por allowlist de hosts.', scope: 'tool:http' },
];

const DISABLED = ['shell', 'filesystem', 'docker', 'kubernetes', 'aws', 'terraform'];

export function Tools() {
  const t = useT();
  return (
    <Page className="space-y-6">
      <PageHeader title={t('Herramientas')} subtitle={t('Catálogo de tools que los agentes pueden invocar, autorizadas por RBAC.')} />

      <div>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-txt-primary">
          <ShieldCheck size={16} className="text-success" /> {t('Habilitadas')}
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {ENABLED.map((tool) => (
            <Card key={tool.key} hover className="flex items-start gap-3 p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/12 text-success">{tool.icon}</div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-txt-primary">{tool.key}</span>
                  <Badge tone="success">
                    <Dot tone="success" /> {t('activa')}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-txt-secondary">{t(tool.desc)}</p>
                <div className="mt-2 inline-flex items-center gap-1 rounded-md bg-elevated px-2 py-0.5 font-mono text-[11px] text-txt-secondary">
                  <Lock size={11} /> {tool.scope}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-txt-primary">
          <ShieldAlert size={16} className="text-warning" /> {t('Deshabilitadas (hasta el sandbox de M8a)')}
        </div>
        <Card className="flex flex-wrap gap-2 p-5">
          {DISABLED.map((d) => (
            <span key={d} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1 font-mono text-xs text-txt-disabled">
              <Lock size={12} /> {d}
            </span>
          ))}
        </Card>
        <p className="mt-2 text-xs text-txt-disabled">
          {t('Las herramientas peligrosas se habilitarán con aislamiento (sandbox por privilegio) para evitar ejecución sin contención.')}
        </p>
      </div>
    </Page>
  );
}
