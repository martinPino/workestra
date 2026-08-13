import { Hono } from 'hono';
import { InviteMemberSchema, UpdateMemberSchema, AcceptInviteSchema } from '@core/contracts';
import { BadRequestException } from '../common';
import { requireScopes } from '../scopes.middleware';
import { rateLimit } from '../rate-limit.middleware';
import type { RouterEnv } from './types';

/**
 * Gestión de equipo (M74): port de `TeamController`.
 *
 * Las rutas de gestión exigen `team:manage` (OWNER/ADMIN); las reglas finas —proteger al OWNER, que un
 * admin no toque a otro admin— las sigue aplicando `TeamService`, no el router. Las de aceptar
 * invitación son públicas porque el invitado aún no tiene sesión, y llevan rate-limit.
 */
export function teamRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.get('/members', requireScopes('team:manage'), async (c) => c.json(await c.get('services').team.list(c.get('user').email)));

  r.post('/invitations', requireScopes('team:manage'), async (c) => {
    const parsed = InviteMemberSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    return c.json(await c.get('services').team.invite(c.get('user').email, parsed.data));
  });

  r.delete('/invitations/:id', requireScopes('team:manage'), async (c) =>
    c.json(await c.get('services').team.revokeInvite(c.get('user').email, c.req.param('id'))),
  );

  r.patch('/members/:userId', requireScopes('team:manage'), async (c) => {
    const parsed = UpdateMemberSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    return c.json(await c.get('services').team.updateMember(c.get('user').email, c.req.param('userId'), parsed.data));
  });

  // ---- Público: aceptar una invitación (el invitado no tiene sesión todavía) ----

  r.get('/invite/:token', async (c) => c.json(await c.get('services').team.invitePreview(c.req.param('token'))));

  r.post('/invite/:token/accept', rateLimit(), async (c) => {
    const parsed = AcceptInviteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    return c.json(await c.get('services').team.accept(c.req.param('token'), parsed.data));
  });

  return r;
}
