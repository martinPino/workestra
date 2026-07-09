import nodemailer, { type Transporter } from 'nodemailer';
import type { IEmailService, EmailMessage } from '@core/engine';

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
 * Envío por SMTP (M74) — el camino GRATIS sin verificar dominio: usa una cuenta de correo existente (p. ej.
 * Gmail con una «contraseña de aplicación»). `nodemailer` es JS puro (sin binario nativo → sin riesgo de
 * build). Best-effort: cualquier fallo se registra y devuelve false; nunca lanza. Config por env:
 * SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS (para Gmail: smtp.gmail.com:465 secure=true).
 */
export class SmtpEmailAdapter implements IEmailService {
  readonly configured = true;
  private readonly transporter: Transporter;
  constructor(
    private readonly from: string,
    opts: { host: string; port: number; secure: boolean; user: string; pass: string },
  ) {
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.user, pass: opts.pass },
    });
  }

  async send(msg: EmailMessage): Promise<boolean> {
    try {
      await this.transporter.sendMail({ from: this.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
      return true;
    } catch (e) {
      console.error('[email:smtp] error enviando a', msg.to, '-', e instanceof Error ? e.message : String(e));
      return false;
    }
  }
}

/**
 * Elige el proveedor por entorno, en orden de preferencia:
 *  1) SMTP (SMTP_HOST+SMTP_USER+SMTP_PASS) — gratis, sin dominio, llega a cualquiera (p. ej. Gmail).
 *  2) Resend (RESEND_API_KEY+EMAIL_FROM) — requiere dominio verificado para destinatarios arbitrarios.
 *  3) Consola (fallback) — no envía; el enlace de invitación siempre queda copiable.
 */
export function createEmailService(): IEmailService {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT, SMTP_SECURE, RESEND_API_KEY, EMAIL_FROM } = process.env;
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    const port = Number(SMTP_PORT ?? 465);
    // Por defecto `secure` según el puerto (465→TLS directo; 587→STARTTLS). Override con SMTP_SECURE.
    const secure = SMTP_SECURE != null ? SMTP_SECURE === 'true' || SMTP_SECURE === '1' : port === 465;
    return new SmtpEmailAdapter(EMAIL_FROM ?? SMTP_USER, { host: SMTP_HOST, port, secure, user: SMTP_USER, pass: SMTP_PASS });
  }
  if (RESEND_API_KEY && EMAIL_FROM) return new ResendEmailAdapter(RESEND_API_KEY, EMAIL_FROM);
  return new ConsoleEmailAdapter();
}
