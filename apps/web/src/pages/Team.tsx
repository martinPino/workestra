import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { UserPlus, Copy, Check, Ban, RotateCcw, Trash2, Loader2, Crown, Mail } from 'lucide-react';
import { Page } from '../app/AppShell';
import { PageHeader, Button, Input, Badge } from '../ui';
import { api, type TeamMemberDto, type TeamDataDto } from '../lib/api';
import type { Role } from '../lib/auth';
import { useT } from '../i18n';

const ROLE_LABEL: Record<Role, string> = { OWNER: 'Propietario', ADMIN: 'Administrador', EDITOR: 'Miembro', VIEWER: 'Solo lectura' };
const ROLE_TONE: Record<Role, 'accent' | 'primary' | 'default'> = { OWNER: 'accent', ADMIN: 'primary', EDITOR: 'default', VIEWER: 'default' };
const initials = (name: string, email: string) => {
  const s = (name || email || '?').trim();
  const p = s.split(/\s+/).filter(Boolean);
  return (p.length >= 2 ? p[0][0] + p[1][0] : s.slice(0, 2)).toUpperCase();
};
const cleanError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^HTTP \d+:\s*/, '');

/** Roles que el actor puede ASIGNAR (owner puede nombrar admins; un admin no). */
function assignableRoles(myRole: Role): Role[] {
  return myRole === 'OWNER' ? ['ADMIN', 'EDITOR', 'VIEWER'] : ['EDITOR', 'VIEWER'];
}

/** ¿Puede el actor gestionar (rol/estado) a este miembro? Espeja las reglas del backend (solo para la UI). */
function canManage(me: TeamDataDto['me'], target: TeamMemberDto): boolean {
  if (target.role === 'OWNER') return false; // al propietario no lo toca nadie
  if (target.userId === me.userId) return false; // ni a ti mismo
  if (me.role === 'ADMIN' && target.role === 'ADMIN') return false; // solo el propietario gestiona admins
  return true;
}

export function Team() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['team'], queryFn: api.getTeam, retry: false });

  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('EDITOR');
  const [lastInvite, setLastInvite] = useState<{ url: string; emailSent: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [formErr, setFormErr] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['team'] });
  const invite = useMutation({
    mutationFn: (input: { email: string; role: Role }) => api.inviteMember(input),
    onSuccess: (r) => {
      setLastInvite({ url: r.acceptUrl, emailSent: r.emailSent });
      setEmail('');
      setFormErr('');
      void refresh();
    },
    onError: (e) => setFormErr(cleanError(e)),
  });
  const patch = useMutation({ mutationFn: (v: { userId: string; role?: Role; disabled?: boolean }) => api.updateMember(v.userId, v), onSuccess: refresh, onError: (e) => alert(cleanError(e)) });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeInvite(id), onSuccess: refresh });

  const onInvite = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate({ email: email.trim(), role: inviteRole });
  };
  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard bloqueado: el enlace ya está visible para copiar a mano */
    }
  };

  if (isLoading)
    return (
      <Page>
        <PageHeader title={t('Equipo')} subtitle={t('Gestiona quién tiene acceso a tu espacio.')} />
        <div className="flex items-center gap-2 p-6 text-sm text-txt-secondary"><Loader2 size={15} className="animate-spin" /> {t('Cargando…')}</div>
      </Page>
    );
  if (error || !data)
    return (
      <Page>
        <PageHeader title={t('Equipo')} subtitle={t('Gestiona quién tiene acceso a tu espacio.')} />
        <div className="rounded-xl border border-border bg-elevated p-6 text-sm text-txt-secondary">
          {t('No tienes permiso para gestionar el equipo. Pídeselo a un administrador.')}
        </div>
      </Page>
    );

  const roleOptions = assignableRoles(data.me.role);

  return (
    <Page className="max-w-3xl space-y-6">
      <PageHeader title={t('Equipo')} subtitle={t('Invita a compañeros y gestiona sus roles y accesos.')} />

      {/* Invitar */}
      <section className="rounded-xl border border-border bg-elevated p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-txt-primary"><UserPlus size={15} /> {t('Invitar a alguien')}</h2>
        <form onSubmit={onInvite} className="flex flex-wrap items-end gap-2">
          <label className="min-w-[220px] flex-1">
            <span className="mb-1 block text-xs font-medium text-txt-secondary">{t('Email')}</span>
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="companero@empresa.com" />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-txt-secondary">{t('Rol')}</span>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
              className="h-9 rounded-lg border border-border bg-surface px-3 text-sm text-txt-primary outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            >
              {roleOptions.map((r) => (
                <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="primary" disabled={invite.isPending}>
            {invite.isPending ? <Loader2 size={15} className="animate-spin" /> : t('Invitar')}
          </Button>
        </form>
        {formErr && <p className="mt-2 text-xs text-danger">{formErr}</p>}
        {lastInvite && (
          <div className="mt-3 rounded-lg border border-success/30 bg-success/5 p-3 text-xs">
            <div className="mb-1.5 flex items-center gap-1.5 font-medium text-txt-primary">
              <Check size={13} className="text-success" />
              {lastInvite.emailSent ? t('Invitación enviada por email.') : t('Invitación creada. Copia y comparte este enlace:')}
            </div>
            {!data.emailConfigured && (
              <p className="mb-1.5 flex items-center gap-1 text-txt-disabled"><Mail size={11} /> {t('El envío de correo no está configurado; comparte el enlace manualmente.')}</p>
            )}
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] text-txt-secondary">{lastInvite.url}</code>
              <button onClick={() => copyLink(lastInvite.url)} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-txt-secondary hover:text-txt-primary">
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />} {copied ? t('Copiado') : t('Copiar')}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Miembros */}
      <section className="rounded-xl border border-border bg-elevated">
        <h2 className="border-b border-border px-5 py-3 text-sm font-semibold text-txt-primary">{t('Miembros')} · {data.members.length}</h2>
        <ul className="divide-y divide-border">
          {data.members.map((m) => {
            const manage = canManage(data.me, m);
            const disabled = !!m.disabledAt;
            return (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-[11px] font-semibold text-white ${disabled ? 'opacity-40' : ''}`}>
                  {initials(m.name, m.email)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`truncate text-sm font-medium ${disabled ? 'text-txt-disabled line-through' : 'text-txt-primary'}`}>{m.name}</span>
                    {m.userId === data.me.userId && <span className="text-[10px] text-txt-disabled">({t('tú')})</span>}
                  </div>
                  <div className="truncate text-xs text-txt-disabled">{m.email}</div>
                </div>
                {disabled && <Badge tone="warning">{t('Desactivado')}</Badge>}
                {m.role === 'OWNER' ? (
                  <Badge tone="accent"><span className="inline-flex items-center gap-1"><Crown size={11} /> {t(ROLE_LABEL.OWNER)}</span></Badge>
                ) : manage ? (
                  <select
                    value={m.role}
                    onChange={(e) => patch.mutate({ userId: m.userId, role: e.target.value as Role })}
                    disabled={patch.isPending}
                    className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-txt-primary outline-none focus:border-primary/60"
                  >
                    {roleOptions.map((r) => (
                      <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>
                    ))}
                  </select>
                ) : (
                  <Badge tone={ROLE_TONE[m.role]}>{t(ROLE_LABEL[m.role])}</Badge>
                )}
                {manage && (
                  <button
                    onClick={() => patch.mutate({ userId: m.userId, disabled: !disabled })}
                    disabled={patch.isPending}
                    title={disabled ? t('Reactivar') : t('Cerrar cuenta')}
                    className={`flex h-8 w-8 items-center justify-center rounded-md text-txt-secondary transition-colors ${disabled ? 'hover:text-success' : 'hover:text-danger'}`}
                  >
                    {disabled ? <RotateCcw size={14} /> : <Ban size={14} />}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Invitaciones pendientes */}
      {data.invitations.length > 0 && (
        <section className="rounded-xl border border-border bg-elevated">
          <h2 className="border-b border-border px-5 py-3 text-sm font-semibold text-txt-primary">{t('Invitaciones pendientes')} · {data.invitations.length}</h2>
          <ul className="divide-y divide-border">
            {data.invitations.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 px-5 py-3">
                <Mail size={15} className="shrink-0 text-txt-disabled" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-txt-primary">{inv.email}</div>
                  <div className="text-xs text-txt-disabled">{t('Caduca')} {new Date(inv.expiresAt).toLocaleDateString('es-ES')}</div>
                </div>
                <Badge tone={ROLE_TONE[inv.role]}>{t(ROLE_LABEL[inv.role])}</Badge>
                <button onClick={() => revoke.mutate(inv.id)} disabled={revoke.isPending} title={t('Revocar')} className="flex h-8 w-8 items-center justify-center rounded-md text-txt-secondary hover:text-danger">
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Page>
  );
}
