import { describe, it, expect } from 'vitest';
import { listTriggerEvents, getTriggerEvent, TRIGGER_EVENTS } from './trigger-events';

describe('trigger-events', () => {
  it('incluye las recetas base (manual, horario, Jira creado/actualizado)', () => {
    const ids = listTriggerEvents().map((e) => e.id);
    expect(ids).toContain('manual');
    expect(ids).toContain('schedule');
    expect(ids).toContain('jira.issue_created');
    expect(ids).toContain('jira.issue_updated');
  });

  it('cada receta mapea a una categoría de trigger del motor (manual/cron/webhook)', () => {
    for (const e of TRIGGER_EVENTS) {
      expect(['manual', 'cron', 'webhook']).toContain(e.triggerEvent);
    }
  });

  it('las recetas de app conectada declaran proveedor + eventos del proveedor', () => {
    const jira = getTriggerEvent('jira.issue_created');
    expect(jira?.kind).toBe('external');
    expect(jira?.provider).toBe('jira');
    expect(jira?.providerEvents).toEqual(['jira:issue_created']);
    expect(jira?.triggerEvent).toBe('webhook');
  });

  it('devuelve null para un id desconocido', () => {
    expect(getTriggerEvent('nope')).toBeNull();
  });
});
