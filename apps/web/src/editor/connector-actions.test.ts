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
    expect(field('github', 'create-issue', 'owner')?.insert).toBeFalsy();
    expect(field('github', 'create-issue', 'repo')?.insert).toBeFalsy();
    expect(field('google-sheets', 'append-row', 'spreadsheetId')?.insert).toBeFalsy();
    expect(field('salesforce', 'create-record', 'object')?.insert).toBeFalsy();
  });
});
