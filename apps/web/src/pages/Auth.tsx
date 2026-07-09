import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth, hasValidSession, type SessionUser } from '../lib/auth';
import { Button, Input } from '../ui';
import { useT } from '../i18n';

/** Limpia el prefijo «HTTP 4xx: » de los errores del cliente API para mostrar solo el mensaje humano. */
function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^HTTP \d+:\s*/, '');
}

/** Marco visual compartido por Login, Registro y Aceptar invitación: tarjeta centrada con la marca. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl brand-gradient shadow-glow">
            <span className="text-lg font-bold text-white">A</span>
          </div>
          <div className="mt-3 text-lg font-semibold tracking-tight text-txt-primary">AgentFlow</div>
          <h1 className="mt-5 text-xl font-semibold text-txt-primary">{t(title)}</h1>
          <p className="mt-1 text-sm text-txt-secondary">{t(subtitle)}</p>
        </div>
        <div className="rounded-2xl border border-border bg-elevated p-6 shadow-card">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const t = useT();
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-txt-secondary">{t(label)}</span>
      <Input {...props} />
    </label>
  );
}

function useAuthSubmit() {
  const navigate = useNavigate();
  const setAuth = useAuth((s) => s.setAuth);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<{ accessToken: string; user: SessionUser }>) => {
    setBusy(true);
    setError('');
    try {
      const { accessToken, user } = await fn();
      setAuth({ token: accessToken, user });
      navigate('/', { replace: true });
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  return { run, error, busy };
}

export function Login() {
  const t = useT();
  const { run, error, busy } = useAuthSubmit();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  if (hasValidSession()) return <Navigate to="/" replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.login({ email, password }));
  };

  return (
    <AuthShell title="Inicia sesión" subtitle="Bienvenido de nuevo a AgentFlow">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com" autoFocus />
        <Field label="Contraseña" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        {error && <p className="text-xs text-danger">{error}</p>}
        <Button type="submit" variant="primary" className="mt-1 w-full justify-center" disabled={busy}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : t('Entrar')}
        </Button>
      </form>
      <p className="mt-4 text-center text-xs text-txt-secondary">
        {t('¿No tienes cuenta?')}{' '}
        <Link to="/register" className="font-medium text-primary hover:underline">
          {t('Crea una')}
        </Link>
      </p>
    </AuthShell>
  );
}

export function Register() {
  const t = useT();
  const { run, error, busy } = useAuthSubmit();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  if (hasValidSession()) return <Navigate to="/" replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.register({ name, email, password }));
  };

  return (
    <AuthShell title="Crea tu cuenta" subtitle="Empieza a automatizar en minutos">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="Nombre" type="text" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" autoFocus />
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com" />
        <Field label="Contraseña" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('Mínimo 8 caracteres')} />
        {error && <p className="text-xs text-danger">{error}</p>}
        <Button type="submit" variant="primary" className="mt-1 w-full justify-center" disabled={busy}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : t('Crear cuenta')}
        </Button>
      </form>
      <p className="mt-4 text-center text-xs text-txt-secondary">
        {t('¿Ya tienes cuenta?')}{' '}
        <Link to="/login" className="font-medium text-primary hover:underline">
          {t('Inicia sesión')}
        </Link>
      </p>
    </AuthShell>
  );
}
