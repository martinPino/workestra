import { describe, it, expect } from 'vitest';
import { isValidCron } from './schedules.service';

describe('isValidCron (M7-B, validación con rangos)', () => {
  it('acepta patrones válidos', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true); // 9:00 de lun a vie
    expect(isValidCron('30 0,12 1 */2 *')).toBe(true);
    expect(isValidCron('59 23 31 12 7')).toBe(true); // límites superiores
  });

  it('rechaza campos fuera de rango (que BullMQ rechazaría al disparar)', () => {
    expect(isValidCron('99 * * * *')).toBe(false); // minuto > 59
    expect(isValidCron('* 24 * * *')).toBe(false); // hora > 23
    expect(isValidCron('* * 32 * *')).toBe(false); // día-mes > 31
    expect(isValidCron('* * * 13 *')).toBe(false); // mes > 12
    expect(isValidCron('* * * * 8')).toBe(false); // día-semana > 7
  });

  it('rechaza número de campos incorrecto y basura', () => {
    expect(isValidCron('* * * *')).toBe(false); // 4 campos
    expect(isValidCron('* * * * * *')).toBe(false); // 6 campos
    expect(isValidCron('cada rato')).toBe(false);
    expect(isValidCron('5-2 * * * *')).toBe(false); // rango invertido
  });
});
