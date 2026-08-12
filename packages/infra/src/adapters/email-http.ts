import type { IEmailService, EmailMessage } from '@core/engine';

/**
 * Proveedores de correo que hablan HTTP (`fetch`) y NADA de Node. Viven separados de `email.ts` porque
 * ese fichero importa `nodemailer` para el camino SMTP, y en Cloudflare Workers no hay TCP crudo: el
 * entry point `@core/infra/cloudflare` importa SOLO desde aquí para no arrastrar nodemailer al bundle.
 */

/**
 * Sin proveedor de correo (M74): registra el mensaje en consola y devuelve false («no entregado»). Es el
 * fallback en dev y cuando falta RESEND_API_KEY. El flujo de invitación sigue funcionando porque el enlace
 * también se devuelve en la respuesta de la API para copiarlo a mano.
 */
export class ConsoleEmailAdapter implements IEmailService {
  readonly configured = false;
  async send(msg: EmailMessage): Promise<boolean> {
    console.log(`[email:console] (sin proveedor) para=${msg.to} asunto="${msg.subject}"`);
    return false;
  }
}

/**
 * Envío por Resend (M74) vía su API HTTP (fetch, sin dependencia). Best-effort: cualquier fallo se registra
 * y devuelve false; nunca lanza, para no tumbar la creación de la invitación. Requiere RESEND_API_KEY y una
 * dirección remitente verificada en EMAIL_FROM (p. ej. "AgentFlow <no-reply@tudominio.com>").
 */
export class ResendEmailAdapter implements IEmailService {
  readonly configured = true;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(msg: EmailMessage): Promise<boolean> {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.error(`[email:resend] fallo ${res.status} enviando a ${msg.to}`);
        return false;
      }
      return true;
    } catch (e) {
      console.error('[email:resend] error de red:', e instanceof Error ? e.message : String(e));
      return false;
    }
  }
}

/**
 * Envío por Brevo (M74) vía su API HTTP (puerto 443 → funciona en PaaS que bloquean SMTP como Railway).
 * Gratis (300/día) y sin dominio: basta verificar UN remitente en Brevo. Best-effort: nunca lanza, devuelve
 * false si falla. `from` es "Nombre <email>"; el email DEBE ser un remitente verificado en la cuenta Brevo.
 */
export class BrevoEmailAdapter implements IEmailService {
  readonly configured = true;
  private readonly sender: { email: string; name: string };
  constructor(
    private readonly apiKey: string,
    from: string,
  ) {
    this.sender = parseFrom(from);
  }

  async send(msg: EmailMessage): Promise<boolean> {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': this.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: this.sender, to: [{ email: msg.to }], subject: msg.subject, htmlContent: msg.html, textContent: msg.text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.error(`[email:brevo] fallo ${res.status} enviando a ${msg.to}`);
        return false;
      }
      return true;
    } catch (e) {
      console.error('[email:brevo] error de red:', e instanceof Error ? e.message : String(e));
      return false;
    }
  }
}

/** Parsea "Nombre <email@dominio>" → { name, email }; si no lleva nombre, usa "AgentFlow". */
export function parseFrom(raw: string): { email: string; name: string } {
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || 'AgentFlow').replace(/^"|"$/g, ''), email: m[2].trim() };
  return { name: 'AgentFlow', email: raw.trim() };
}

/**
 * Elige un proveedor HTTP a partir de una bolsa de config (en Workers, `env`; en Node, `process.env`).
 * Orden: Brevo → Resend → consola. NO contempla SMTP: quien lo quiera usa `createEmailService()` de
 * `email.ts`, que solo funciona donde haya sockets TCP.
 */
export function createHttpEmailService(cfg: Record<string, string | undefined>): IEmailService {
  const { BREVO_API_KEY, RESEND_API_KEY, EMAIL_FROM } = cfg;
  if (BREVO_API_KEY && EMAIL_FROM) return new BrevoEmailAdapter(BREVO_API_KEY, EMAIL_FROM);
  if (RESEND_API_KEY && EMAIL_FROM) return new ResendEmailAdapter(RESEND_API_KEY, EMAIL_FROM);
  return new ConsoleEmailAdapter();
}
