import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Search, Star, Download, Bot, Workflow, Wrench, Plug } from 'lucide-react';
import { Page } from '../app/AppShell';
import { Card, Badge, PageHeader, Input } from '../ui';
import { cn } from '../lib/cn';

type Cat = 'all' | 'agents' | 'workflows' | 'tools' | 'connectors';

interface Item {
  name: string;
  author: string;
  desc: string;
  cat: Exclude<Cat, 'all'>;
  rating: number;
  downloads: string;
  gradient: string;
}

const ITEMS: Item[] = [
  { name: 'Backend Agent Pro', author: 'agentflow', desc: 'Java/Spring, Git, Docker, Postgres, Maven.', cat: 'agents', rating: 4.9, downloads: '12.4k', gradient: 'from-indigo-500 to-fuchsia-500' },
  { name: 'QA Playwright', author: 'agentflow', desc: 'E2E testing con Playwright y reportes.', cat: 'agents', rating: 4.8, downloads: '9.1k', gradient: 'from-emerald-500 to-teal-500' },
  { name: 'Bug → PR pipeline', author: 'community', desc: 'De un bug de Jira a un PR revisado.', cat: 'workflows', rating: 4.7, downloads: '6.3k', gradient: 'from-amber-500 to-orange-500' },
  { name: 'Incident Responder', author: 'ops-guild', desc: 'Triage de alertas de Sentry y runbooks.', cat: 'workflows', rating: 4.6, downloads: '3.8k', gradient: 'from-rose-500 to-pink-500' },
  { name: 'HTTP Tool+', author: 'agentflow', desc: 'Cliente HTTP con allowlist y reintentos.', cat: 'tools', rating: 4.9, downloads: '18.2k', gradient: 'from-sky-500 to-blue-500' },
  { name: 'GitHub Connector', author: 'agentflow', desc: 'Issues, PRs, commits y webhooks.', cat: 'connectors', rating: 4.9, downloads: '22.7k', gradient: 'from-zinc-500 to-zinc-700' },
  { name: 'Slack Connector', author: 'agentflow', desc: 'Mensajes, canales y comandos.', cat: 'connectors', rating: 4.8, downloads: '15.9k', gradient: 'from-purple-500 to-violet-500' },
  { name: 'Notion Sync', author: 'community', desc: 'Sincroniza docs y bases de datos.', cat: 'connectors', rating: 4.5, downloads: '5.1k', gradient: 'from-neutral-400 to-neutral-600' },
];

const CATS: { key: Cat; label: string; icon: React.ReactNode }[] = [
  { key: 'all', label: 'Todo', icon: <Star size={13} /> },
  { key: 'agents', label: 'Agentes', icon: <Bot size={13} /> },
  { key: 'workflows', label: 'Workflows', icon: <Workflow size={13} /> },
  { key: 'tools', label: 'Herramientas', icon: <Wrench size={13} /> },
  { key: 'connectors', label: 'Conectores', icon: <Plug size={13} /> },
];

export function Marketplace() {
  const [cat, setCat] = useState<Cat>('all');
  const [q, setQ] = useState('');

  const items = useMemo(
    () => ITEMS.filter((it) => (cat === 'all' || it.cat === cat) && it.name.toLowerCase().includes(q.toLowerCase())),
    [cat, q],
  );

  return (
    <Page className="space-y-6">
      <PageHeader title="Marketplace" subtitle="Descubre y reutiliza agentes, workflows, herramientas y conectores." />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-sm">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-txt-disabled" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar en el marketplace…" className="pl-9" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {CATS.map((c) => (
            <button
              key={c.key}
              onClick={() => setCat(c.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                cat === c.key ? 'border-primary/30 bg-primary/12 text-primary' : 'border-border bg-card text-txt-secondary hover:text-txt-primary',
              )}
            >
              {c.icon} {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((it, i) => (
          <motion.div key={it.name} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
            <Card hover className="group flex h-full flex-col p-5">
              <div className={`mb-4 flex h-24 items-center justify-center rounded-lg bg-gradient-to-br ${it.gradient}`}>
                <div className="text-2xl font-bold text-white/90">{it.name.charAt(0)}</div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-txt-primary">{it.name}</span>
                <Badge tone="default">{it.cat}</Badge>
              </div>
              <p className="mt-1 flex-1 text-xs text-txt-secondary">{it.desc}</p>
              <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-xs text-txt-secondary">
                <span>por {it.author}</span>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <Star size={12} className="fill-warning text-warning" /> {it.rating}
                  </span>
                  <span className="flex items-center gap-1">
                    <Download size={12} /> {it.downloads}
                  </span>
                </div>
              </div>
            </Card>
          </motion.div>
        ))}
      </div>
    </Page>
  );
}
