import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth, type Role } from '../lib/auth';
import { AuthShell } from './Auth';
import { Button, Input } from '../ui';
import { useT } from '../i18n';

const ROLE_LABEL: Record<Role, string> = { OWNER: 'Propietario', ADMIN: 'Administrador', EDITOR: 'Miembro', VIEWER: 'Solo lectura' };
const cleanError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^HTTP \d+:\s*/, '');

/** Página pública de aceptar invitación (M74): valida el token, y el invitado crea su cuenta y se une. */
export function AcceptInvite() {
  const t = useT();
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const setAuth = useAuth((s) => s.setAuth);
  const { data, isLoading, error } = useQuery({ queryKey: ['invite', token], queryFn: () => api.getInvite(token as string), enabled: !!token, retry: false });

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const { accessToken, user } = await api.acceptInvite(token as string, { name, password });
      setAuth({ token: accessToken, user });
      navigate('/', { replace: true });
    } catch (e2) {
      setErr(cleanError(e2));
    } finally {
      setBusy(false);
    }
  };

  if (isLoading)
    return (
      <AuthShell title="Invitación" subtitle="Comprobando tu invitación…">
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-txt-secondary"><Loader2 size={16} className="animate-spin" /> {t('Cargando…')}</div>
      </AuthShell>
    );

  if (error || !data)
    return (
      <AuthShell title="Invitación no válida" subtitle="El enlace no es válido o ha caducado">
        <p className="text-sm text-txt-secondary">{t('Pídele a quien te invitó que te envíe una invitación nueva.')}</p>
        <p className="mt-4 text-center text-xs text-txt-secondary">
          <Link to="/login" className="font-medium text-primary hover:underline">{t('Ir a iniciar sesión')}</Link>
        </p>
      </AuthShell>
    );

  return (
    <AuthShell title="Únete al equipo" subtitle={`Te han invitado como ${t(ROLE_LABEL[data.role])}`}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-txt-secondary">{t('Email')}</span>
          <Input type="email" value={data.email} readOnly disabled className="opacity-70" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-txt-secondary">{t('Tu nombre')}</span>
          <Input type="text" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Tu nombre')} autoFocus />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-txt-secondary">{t('Crea una contraseña')}</span>
          <Input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('Mínimo 8 caracteres')} />
        </label>
        {err && <p className="text-xs text-danger">{err}</p>}
        <Button type="submit" variant="primary" className="mt-1 w-full justify-center" disabled={busy}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : t('Unirme al equipo')}
        </Button>
      </form>
    </AuthShell>
  );
}
