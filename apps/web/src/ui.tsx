import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { motion } from 'framer-motion';
import { cn } from './lib/cn';

/* ------------------------------- Button ------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md';

const BTN_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all duration-150 ease-smooth focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-40 disabled:pointer-events-none select-none';

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary:
    'text-white shadow-subtle bg-gradient-to-br from-primary to-accent hover:brightness-110 active:brightness-95',
  secondary: 'bg-elevated text-txt-primary border border-border hover:border-border-strong hover:bg-card',
  subtle: 'bg-card text-txt-secondary hover:text-txt-primary hover:bg-elevated',
  ghost: 'text-txt-secondary hover:text-txt-primary hover:bg-elevated',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25 border border-danger/20',
};

const BTN_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button className={cn(BTN_BASE, BTN_VARIANT[variant], BTN_SIZE[size], className)} {...props}>
      {children}
    </button>
  );
}

export function IconButton({
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg text-txt-secondary transition-colors hover:bg-elevated hover:text-txt-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* -------------------------------- Card -------------------------------- */

export function Card({
  className,
  children,
  hover,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { hover?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card shadow-subtle',
        hover && 'transition-all duration-200 ease-smooth hover:border-border-strong hover:shadow-card',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/* ------------------------------- Badge -------------------------------- */

type Tone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'accent';
const TONE: Record<Tone, string> = {
  default: 'bg-elevated text-txt-secondary border-border',
  primary: 'bg-primary/12 text-primary border-primary/20',
  success: 'bg-success/12 text-success border-success/20',
  warning: 'bg-warning/12 text-warning border-warning/20',
  danger: 'bg-danger/12 text-danger border-danger/20',
  accent: 'bg-accent/12 text-accent border-accent/20',
};

export function Badge({ tone = 'default', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium', TONE[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone = 'default', pulse }: { tone?: Tone; pulse?: boolean }) {
  const c: Record<Tone, string> = {
    default: 'bg-muted',
    primary: 'bg-primary',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    accent: 'bg-accent',
  };
  return <span className={cn('inline-block h-2 w-2 rounded-full', c[tone], pulse && 'animate-pulse')} />;
}

/* --------------------------------- Kbd -------------------------------- */

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[10px] font-medium text-txt-secondary shadow-subtle">
      {children}
    </kbd>
  );
}

/* ------------------------------- Inputs ------------------------------- */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-txt-primary placeholder:text-txt-disabled outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20',
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-txt-primary placeholder:text-txt-disabled outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20',
        className,
      )}
      {...props}
    />
  );
});

export function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200',
        checked ? 'bg-primary' : 'bg-elevated border border-border',
      )}
    >
      <span
        className={cn(
          // `left-0` fija el origen; sin él, el `left:auto` del absoluto caía en la posición estática
          // (~17px) → el círculo aparecía a la derecha en OFF y se salía de la pista en ON.
          'absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/* ------------------------------ Skeleton ------------------------------ */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded-md bg-elevated', className)}>
      <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/5 to-transparent [animation:shimmer_1.4s_infinite]" />
    </div>
  );
}

/* ------------------------------ EmptyState ---------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
      {icon && (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-elevated text-txt-secondary">
          {icon}
        </div>
      )}
      <div className="text-sm font-medium text-txt-primary">{title}</div>
      {description && <div className="mt-1 max-w-sm text-xs text-txt-secondary">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* -------------------------------- Stat -------------------------------- */

export function Stat({
  label,
  value,
  delta,
  icon,
  tone = 'primary',
}: {
  label: string;
  value: ReactNode;
  delta?: string;
  icon?: ReactNode;
  tone?: Tone;
}) {
  const iconTone: Record<Tone, string> = {
    default: 'bg-elevated text-txt-secondary',
    primary: 'bg-primary/12 text-primary',
    success: 'bg-success/12 text-success',
    warning: 'bg-warning/12 text-warning',
    danger: 'bg-danger/12 text-danger',
    accent: 'bg-accent/12 text-accent',
  };
  return (
    <Card hover className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs font-medium text-txt-secondary">{label}</div>
          <div className="mt-1.5 text-2xl font-semibold tracking-tight text-txt-primary">{value}</div>
          {delta && <div className="mt-1 text-[11px] text-txt-secondary">{delta}</div>}
        </div>
        {icon && <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', iconTone[tone])}>{icon}</div>}
      </div>
    </Card>
  );
}

/* ------------------------------ Tabs (light) -------------------------- */

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'relative rounded-md px-3 py-1 text-xs font-medium transition-colors',
            active === t.key ? 'text-txt-primary' : 'text-txt-secondary hover:text-txt-primary',
          )}
        >
          {active === t.key && (
            <motion.span
              layoutId="tab-pill"
              className="absolute inset-0 rounded-md bg-elevated"
              transition={{ type: 'spring', stiffness: 400, damping: 32 }}
            />
          )}
          <span className="relative">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-txt-primary sm:text-xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-txt-secondary">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
