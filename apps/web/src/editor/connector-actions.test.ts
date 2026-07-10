import { describe, it, expect } from 'vitest';
import { CONNECTOR_ACTIONS } from './connector-actions';

const field = (provider: string, actionId: string, key: string) =>
  CONNECTOR_ACTIONS[provider]?.find((a) => a.id === actionId)?.fields.find((f) => f.key === key);

describe('acciones Slack (M58)', () => {
  it('solo queda «enviar un mensaje»; se retiró «añadir una reacción»', () => {
    const ids = CONNECTOR_ACTIONS.slack.map((a) => a.id);
    expect(ids).toEqual(['post-message']);
    expect(ids).not.toContain('add-reaction');
  });
  it('el canal es un desplegable (source) y el mensaje lleva insertor', () => {
    expect(field('slack', 'post-message', 'channel')?.source).toBe('slack-channel');
    expect(field('slack', 'post-message', 'channel')?.insert).toBeFalsy();
    expect(field('slack', 'post-message', 'text')?.insert).toBe(true);
  });
});

describe('insertor solo en campos de contenido (M58)', () => {
  it('campos de CONTENIDO/referencia → insert:true', () => {
    expect(field('jira', 'comment', 'comment')?.insert).toBe(true);
    expect(field('jira', 'comment', 'issueKey')?.insert).toBe(true);
    expect(field('github', 'create-issue', 'title')?.insert).toBe(true);
    expect(field('gmail', 'send-email', 'text')?.insert).toBe(true);
    expect(field('salesforce', 'create-record', 'fields')?.insert).toBe(true);
  });
  it('IDENTIFICADORES → sin insertor', () => {
    expect(field('jira', 'transition', 'transitionId')?.insert).toBeFalsy();
    expect(field('jira', 'create-issue', 'issueType')?.insert).toBeFalsy();
    expect(field('github', 'create-issue', 'repo')?.insert).toBeFalsy();
    expect(field('google-sheets', 'append-row', 'spreadsheetId')?.insert).toBeFalsy();
    expect(field('salesforce', 'create-record', 'object')?.insert).toBeFalsy();
  });
});

describe('GitHub: el repo es un desplegable de repos reales', () => {
  const action = CONNECTOR_ACTIONS.github.find((a) => a.id === 'create-issue');
  it('el campo «repo» usa el picker de repos (source) y ya no hay campo «owner» a mano', () => {
    expect(field('github', 'create-issue', 'repo')?.source).toBe('github-repo');
    expect(field('github', 'create-issue', 'owner')).toBeUndefined();
  });
  it('build inserta el owner/repo (full_name) directamente en la ruta', () => {
    const b = action?.build({ repo: 'mi-org/mi-repo', title: 'Bug', body: 'detalle' }, {});
    expect(b?.method).toBe('POST');
    expect(b?.path).toBe('/repos/mi-org/mi-repo/issues');
    expect(JSON.parse(b!.body!)).toEqual({ title: 'Bug', body: 'detalle' });
  });
});

describe('conectores con acciones nombradas (HTTP crudo solo «Avanzado»)', () => {
  const build = (provider: string, actionId: string, params: Record<string, string> = {}) =>
    CONNECTOR_ACTIONS[provider]?.find((a) => a.id === actionId)?.build(params, {});

  it('todos los proveedores de OAuth tienen al menos una acción amigable', () => {
    // Si un proveedor no tiene acciones, el usuario cae directo al HTTP crudo → objetivo: que ninguno lo haga.
    for (const provider of ['hubspot', 'notion', 'stripe', 'figma', 'canva']) {
      expect(CONNECTOR_ACTIONS[provider]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('HubSpot: crear contacto arma properties JSON', () => {
    const b = build('hubspot', 'create-contact', { email: 'a@b.com', firstname: 'Ana', lastname: 'G' });
    expect(b?.method).toBe('POST');
    expect(b?.path).toBe('/crm/v3/objects/contacts');
    expect(JSON.parse(b!.body!)).toEqual({ properties: { email: 'a@b.com', firstname: 'Ana', lastname: 'G' } });
  });

  it('Notion: buscar y crear página; el executor añade la cabecera Notion-Version', () => {
    expect(build('notion', 'search', { query: 'x' })?.path).toBe('/search');
    expect(build('notion', 'create-page', { parentPageId: 'PID', title: 'T' })?.path).toBe('/pages');
  });

  it('Stripe: solo lectura (GET, sin cuerpo)', () => {
    const b = build('stripe', 'find-customer', { email: 'c@d.com' });
    expect(b?.method).toBe('GET');
    expect(b?.body).toBeUndefined();
    expect(b?.path).toContain('email=c%40d.com');
  });

  it('Figma/Canva: lectura por clave/ID', () => {
    expect(build('figma', 'get-file', { fileKey: 'ABC' })?.path).toBe('/files/ABC');
    expect(build('canva', 'get-design', { designId: 'D1' })?.path).toBe('/designs/D1');
  });
});
