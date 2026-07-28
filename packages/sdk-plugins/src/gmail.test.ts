import { describe, it, expect } from 'vitest';
import { gmailRawMessage, safeResponseJson, rowIsAllEmpty } from './connector-node';

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

describe('safeResponseJson (M28b)', () => {
  it('JSON válido y pequeño → objeto parseado (para {{connector:nodo.json.…}})', () => {
    expect(safeResponseJson('{"messages":[{"id":"a"}]}', 'tok')).toEqual({ messages: [{ id: 'a' }] });
  });

  it('respuesta que CONTIENE el token → no se expone (no filtrar el token en un objeto)', () => {
    expect(safeResponseJson('{"echo":"Bearer secreto123"}', 'secreto123')).toBeUndefined();
  });

  it('respuesta demasiado grande (>32KB) → no se expone (no inflar el contexto)', () => {
    const big = JSON.stringify({ x: 'a'.repeat(40_000) });
    expect(safeResponseJson(big, 'tok')).toBeUndefined();
  });

  it('no-JSON (HTML, texto) → undefined', () => {
    expect(safeResponseJson('<html>error</html>', 'tok')).toBeUndefined();
  });
});

// M85: Google Sheets acepta una fila 100% vacía y responde «200, escrito» sin que se vea nada. Como una
// fila entera vacía nunca es intencional, el nodo la corta antes con un mensaje claro.
describe('rowIsAllEmpty — la fila vacía de Sheets que fingía éxito', () => {
  it('detecta una fila con TODAS las celdas vacías o en blanco', () => {
    expect(rowIsAllEmpty('{"values":[["","",""]]}')).toBe(true);
    expect(rowIsAllEmpty('{"values":[["  ","   "]]}')).toBe(true); // solo espacios: sigue siendo vacía
  });

  it('NO corta si alguna celda tiene contenido', () => {
    expect(rowIsAllEmpty('{"values":[["","GERMAN",""]]}')).toBe(false);
    expect(rowIsAllEmpty('{"values":[["", 0, ""]]}')).toBe(false); // un 0 es un dato, no un vacío
  });

  it('ante un cuerpo que no es la forma esperada, NO decide (deja pasar)', () => {
    expect(rowIsAllEmpty('no es json')).toBe(false);
    expect(rowIsAllEmpty('{"otra":"cosa"}')).toBe(false);
    expect(rowIsAllEmpty('{"values":[]}')).toBe(false);
  });
});
