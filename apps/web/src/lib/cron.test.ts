import { describe, it, expect } from 'vitest';
import { buildCron, humanCron, humanEvery } from './cron';

const t = (s: string) => s; // identidad: probamos la forma, no la traducción

describe('buildCron', () => {
  it('genera las cinco formas del picker', () => {
    expect(buildCron('minutes', 15, 0, 0, 0, 1)).toBe('*/15 * * * *');
    expect(buildCron('hourly', 0, 0, 30, 0, 1)).toBe('30 * * * *');
    expect(buildCron('daily', 0, 9, 0, 0, 1)).toBe('0 9 * * *');
    expect(buildCron('weekly', 0, 9, 0, 1, 1)).toBe('0 9 * * 1');
    expect(buildCron('monthly', 0, 9, 0, 0, 15)).toBe('0 9 15 * *');
  });
});

describe('humanCron', () => {
  it('humaniza las formas que genera el picker (ida y vuelta)', () => {
    expect(humanCron('*/15 * * * *', t)).toBe('Cada 15 minutos');
    expect(humanCron('30 * * * *', t)).toBe('Cada hora, al minuto 30');
    expect(humanCron('0 9 * * *', t)).toBe('Cada día a las 09:00');
    expect(humanCron('0 9 * * 1', t)).toBe('Cada lunes a las 09:00');
    expect(humanCron('0 9 15 * *', t)).toBe('El día 15 de cada mes a las 09:00');
  });
  it('cae con gracia al cron crudo en formas no reconocidas (legacy a mano)', () => {
    expect(humanCron('0 9 * * 1-5', t)).toBe('0 9 * * 1-5'); // rango
    expect(humanCron('0,30 9 * * *', t)).toBe('0,30 9 * * *'); // lista
    expect(humanCron('* * *', t)).toBe('* * *'); // malformado
  });
});

describe('humanEvery', () => {
  it('elige la unidad mayor exacta', () => {
    expect(humanEvery(3_600_000)).toBe('cada 1 h');
    expect(humanEvery(300_000)).toBe('cada 5 min');
    expect(humanEvery(15_000)).toBe('cada 15 s');
    expect(humanEvery(1234)).toBe('cada 1234 ms');
  });
});
