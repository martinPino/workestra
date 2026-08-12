import nodemailer, { type Transporter } from 'nodemailer';
import type { IEmailService, EmailMessage } from '@core/engine';
import { ConsoleEmailAdapter, ResendEmailAdapter, BrevoEmailAdapter } from './email-http';

// Los proveedores HTTP (consola/Resend/Brevo) viven en `email-http.ts`, sin dependencias de Node, para que
// el bundle de Cloudflare Workers pueda importarlos SIN arrastrar nodemailer. Se reexportan aquí para no
// romper a quien ya importaba `@core/infra`.
export { ConsoleEmailAdapter, ResendEmailAdapter, BrevoEmailAdapter, parseFrom, createHttpEmailService } from './email-http';

/**
 * Envío por SMTP (M74) — el camino GRATIS sin verificar dominio: usa una cuenta de correo existente (p. ej.
 * Gmail con una «contraseña de aplicación»). `nodemailer` es JS puro (sin binario nativo → sin riesgo de
 * build). Best-effort: cualquier fallo se registra y devuelve false; nunca lanza. Config por env:
 * SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS (para Gmail: smtp.gmail.com:465 secure=true).
 *
 * SOLO NODE: abre un socket TCP. En Cloudflare Workers no existe esta ruta (ver `createHttpEmailService`).
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
      // Timeouts para FALLAR RÁPIDO (~10s) en vez de colgar la petición si el puerto SMTP está bloqueado
      // (p. ej. Railway bloquea el SMTP saliente). Sin esto, un envío bloqueado cuelga la invitación ~30s.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
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
 *  1) Brevo (BREVO_API_KEY+EMAIL_FROM) — HTTPS, gratis, sin dominio, funciona en Railway. RECOMENDADO.
 *  2) Resend (RESEND_API_KEY+EMAIL_FROM) — HTTPS; requiere dominio verificado para destinatarios arbitrarios.
 *  3) SMTP (SMTP_HOST+USER+PASS) — para entornos que NO bloqueen SMTP (Railway sí lo bloquea).
 *  4) Consola (fallback) — no envía; el enlace de invitación siempre queda copiable.
 */
export function createEmailService(): IEmailService {
  const { BREVO_API_KEY, RESEND_API_KEY, SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT, SMTP_SECURE, EMAIL_FROM } = process.env;
  if (BREVO_API_KEY && EMAIL_FROM) return new BrevoEmailAdapter(BREVO_API_KEY, EMAIL_FROM);
  if (RESEND_API_KEY && EMAIL_FROM) return new ResendEmailAdapter(RESEND_API_KEY, EMAIL_FROM);
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    const port = Number(SMTP_PORT ?? 465);
    // Por defecto `secure` según el puerto (465→TLS directo; 587→STARTTLS). Override con SMTP_SECURE.
    const secure = SMTP_SECURE != null ? SMTP_SECURE === 'true' || SMTP_SECURE === '1' : port === 465;
    return new SmtpEmailAdapter(EMAIL_FROM ?? SMTP_USER, { host: SMTP_HOST, port, secure, user: SMTP_USER, pass: SMTP_PASS });
  }
  return new ConsoleEmailAdapter();
}
