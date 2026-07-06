import { describe, it, expect } from 'vitest';
import { extractJsonObject, buildGeneratePrompt, isRateLimitError } from './generate.util';

describe('isRateLimitError (mensaje claro de límite de IA)', () => {
  it('detecta el 429 real de Groq (tokens per day)', () => {
    expect(isRateLimitError('LLM HTTP 429 para el modelo «llama-3.3-70b-versatile»: Rate limit reached ... on tokens per day (TPD): Limit 100000')).toBe(true);
  });
  it('detecta variantes de rate limit / too many requests', () => {
    expect(isRateLimitError('Too Many Requests')).toBe(true);
    expect(isRateLimitError('rate-limit exceeded')).toBe(true);
    expect(isRateLimitError('tokens per minute (TPM) exceeded')).toBe(true);
  });
  it('NO marca otros errores como límite', () => {
    expect(isRateLimitError('LLM HTTP 500: internal error')).toBe(false);
    expect(isRateLimitError('no se encontró JSON en la respuesta')).toBe(false);
    expect(isRateLimitError('ECONNREFUSED')).toBe(false);
  });
});

describe('extractJsonObject (M29)', () => {
  it('JSON pelado → lo devuelve', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('con fences ```json → extrae el interior', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('con texto alrededor → extrae el objeto balanceado', () => {
    expect(extractJsonObject('Aquí tienes:\n{"graph":{"nodes":[]}}\n¡listo!')).toBe('{"graph":{"nodes":[]}}');
  });

  it('prosa CON llave después del JSON → no la incluye (balance, no lastIndexOf)', () => {
    expect(extractJsonObject('{"name":"F","graph":{"nodes":[]}} Espero que esto {te sirva}.')).toBe('{"name":"F","graph":{"nodes":[]}}');
  });

  it('llaves dentro de un string no descuadran el balance', () => {
    expect(extractJsonObject('{"msg":"usa {{var}} aquí"} y ya')).toBe('{"msg":"usa {{var}} aquí"}');
  });

  it('sin JSON → null', () => {
    expect(extractJsonObject('no hay json aquí')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });

  it('objeto sin cerrar → null', () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
  });
});

describe('buildGeneratePrompt (M29)', () => {
  it('incluye los conectores y agentes reales (ids)', () => {
    const p = buildGeneratePrompt([{ id: 'c1', provider: 'gmail', key: 'gmail-1' }], [{ id: 'a1', name: 'Redactor' }]);
    expect(p).toContain('c1 → gmail');
    expect(p).toContain('a1 → Redactor');
    expect(p).toContain('"trigger"');
    expect(p).toContain('"end"');
  });

  it('sin conectores/agentes → indica que no hay (no inventar ids)', () => {
    const p = buildGeneratePrompt([], []);
    expect(p).toContain('(ninguno conectado)');
    expect(p).toContain('(ninguno)');
  });
});
