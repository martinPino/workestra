import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Search, Star, Download, Clock, Users, Sparkles, ArrowRight } from 'lucide-react';
import { Page } from '../app/AppShell';
import { PageHeader, Input } from '../ui';
import { ProviderLogo, hasProviderLogo } from '../lib/provider-logos';
import { cn } from '../lib/cn';
import { useT } from '../i18n';
import { MARKETPLACE, KINDS, COLLECTIONS, type MarketItem, type MarketKind } from '../marketplace/catalog';

const DIFFICULTY_TONE: Record<MarketItem['difficulty'], string> = {
  'Fácil': 'text-success',
  'Media': 'text-warning',
  'Avanzada': 'text-danger',
};

const fmtInstalls = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Fila de logos de conectores + chips de MCP requeridos por un item. */
function Requirements({ item }: { item: MarketItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {item.connectors.map((p) =>
        hasProviderLogo(p) ? (
          <span key={p} className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-white" title={p}>
            <ProviderLogo provider={p} size={14} />
          </span>
        ) : (
          <span key={p} className="rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] text-txt-secondary">{p}</span>
        ),
      )}
      {item.mcps.map((m) => (
        <span key={m} className="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary" title={`MCP: ${m}`}>
          {m}
        </span>
      ))}
    </div>
  );
}

function MarketCard({ item }: { item: MarketItem }) {
  const t = useT();
  const navigate = useNavigate();
  const kind = KINDS.find((k) => k.key === item.kind);
  return (
    <motion.button
      layout
      onClick={() => navigate(`/marketplace/${item.id}`)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="group flex h-full flex-col rounded-2xl border border-border bg-elevated p-4 text-left shadow-card transition-all hover:border-border-strong hover:shadow-pop"
    >
      <div className="flex items-start gap-3">
        <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-xl shadow-subtle', item.gradient)}>{item.icon}</span>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-txt-primary">{item.name}</span>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-txt-disabled">
            <span>{kind?.icon}</span>
            <span className="truncate">{item.category}</span>
          </div>
        </div>
      </div>

      <p className="mt-2.5 line-clamp-2 flex-1 text-xs leading-relaxed text-txt-secondary">{item.tagline}</p>

      <div className="mt-2.5 flex flex-wrap gap-1">
        {item.badges.slice(0, 3).map((b) => (
          <span key={b} className="rounded-full bg-card px-2 py-0.5 text-[10px] font-medium text-txt-secondary">{b}</span>
        ))}
      </div>

      {(item.connectors.length > 0 || item.mcps.length > 0) && (
        <div className="mt-2.5">
          <Requirements item={item} />
        </div>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5 text-[11px] text-txt-disabled">
        <div className="flex items-center gap-2.5">
          {item.kind === 'team' && (
            <span className="inline-flex items-center gap-1" title={t('Agentes')}>
              <Users size={12} /> {item.install.agents?.length ?? 0}
            </span>
          )}
          <span className={cn('font-medium', DIFFICULTY_TONE[item.difficulty])}>{t(item.difficulty)}</span>
          <span className="inline-flex items-center gap-1">
            <Clock size={12} /> {item.setupMinutes}m
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1">
            <Star size={12} className="text-amber-400" /> {item.rating}
          </span>
          <span className="inline-flex items-center gap-1">
            <Download size={12} /> {fmtInstalls(item.installs)}
          </span>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[10px] text-txt-disabled">por {item.author}</span>
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
          {t('Ver')} <ArrowRight size={12} />
        </span>
      </div>
    </motion.button>
  );
}

export function Marketplace() {
  const t = useT();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<MarketKind | 'all'>('all');
  const [collection, setCollection] = useState<string | null>(null);

  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    return MARKETPLACE.filter((it) => {
      if (kind !== 'all' && it.kind !== kind) return false;
      if (collection && !it.collections.includes(collection)) return false;
      if (query && !`${it.name} ${it.tagline} ${it.category}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [q, kind, collection]);

  return (
    <Page className="space-y-6">
      <PageHeader title={t('Marketplace')} subtitle={t('Instala equipos inteligentes, agentes y automatizaciones con un clic.')} />

      <div className="relative max-w-xl">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-txt-disabled" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Busca equipos, agentes, automatizaciones…')} className="pl-9" />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setKind('all')}
          className={cn('flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors', kind === 'all' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-txt-secondary hover:text-txt-primary')}
        >
          <Sparkles size={13} /> {t('Todo')}
        </button>
        {KINDS.map((k) => (
          <button
            key={k.key}
            onClick={() => setKind(k.key)}
            className={cn('flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors', kind === k.key ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-txt-secondary hover:text-txt-primary')}
          >
            <span>{k.icon}</span> {t(k.label)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-txt-disabled">{t('Colecciones')}</span>
        {COLLECTIONS.map((c) => (
          <button
            key={c.id}
            onClick={() => setCollection((cur) => (cur === c.id ? null : c.id))}
            className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors', collection === c.id ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-txt-secondary hover:text-txt-primary')}
          >
            {c.emoji} {c.label}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-border bg-elevated p-10 text-center text-sm text-txt-secondary">{t('No hay resultados. Prueba con otra búsqueda o categoría.')}</div>
      ) : (
        <motion.div layout className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((it) => (
            <MarketCard key={it.id} item={it} />
          ))}
        </motion.div>
      )}
    </Page>
  );
}
