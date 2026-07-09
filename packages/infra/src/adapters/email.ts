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

/** Elige el proveedor por entorno: Resend si hay RESEND_API_KEY + EMAIL_FROM, si no consola (fallback). */
export function createEmailService(): IEmailService {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (apiKey && from) return new ResendEmailAdapter(apiKey, from);
  return new ConsoleEmailAdapter();
}
