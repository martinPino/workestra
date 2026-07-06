import { describe, it, expect } from 'vitest';
import { gmailRawMessage } from './connector-node';

const decode = (raw: string): string => Buffer.from(raw, 'base64url').toString('utf8');

describe('gmailRawMessage (M28)', () => {
  it('produce un MIME base64url con To, Subject (encoded-word) y cuerpo en base64', () => {
    const mime = decode(gmailRawMessage({ to: 'a@b.com', subject: 'Hola', text: 'Cuerpo' }));
    expect(mime).toContain('To: a@b.com');
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from('Hola').toString('base64')}?=`);
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(mime.trimEnd().endsWith(Buffer.from('Cuerpo').toString('base64'))).toBe(true);
  });

  it('sanea saltos de línea del destinatario (no permite inyectar cabeceras)', () => {
    const mime = decode(gmailRawMessage({ to: 'a@b.com\r\nBcc: evil@x.com', subject: 's', text: 't' }));
    expect(mime).not.toMatch(/\r?\nBcc:/); // ninguna cabecera nueva inyectada
    expect(mime).toContain('To: a@b.com Bcc: evil@x.com'); // el salto se colapsa dentro del valor de To
  });

  it('acentos y emoji en asunto/cuerpo sobreviven (UTF-8)', () => {
    const mime = decode(gmailRawMessage({ subject: 'Café ☕', text: 'Ñandú 🚀' }));
    expect(mime).toContain(Buffer.from('Café ☕').toString('base64'));
    expect(mime).toContain(Buffer.from('Ñandú 🚀').toString('base64'));
  });

  it('campos ausentes no rompen (correo vacío válido, sin encoded-word malformado)', () => {
    const mime = decode(gmailRawMessage({}));
    expect(mime).toContain('To: ');
    expect(mime).toContain('MIME-Version: 1.0');
    expect(mime).not.toContain('=?UTF-8?B??='); // encoded-word vacío inválido (RFC 2047)
    expect(mime).toContain('Subject: \r\n'); // asunto vacío legítimo
  });
});
