// Acciones NOMBRADAS por proveedor (M20). Cada acción declara sus campos amigables (canal, texto, ticket…)
// y una función `build` que arma method/path/body por debajo — el usuario nunca ve rutas, JSON ni ADF de
// Jira. El executor sigue leyendo method/path/body, así que el runtime no cambia.

export interface ActionField {
  key: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  default?: string;
}

export interface ConnectorAction {
  id: string;
  label: string;
  /** Campos que rellena el usuario (con lenguaje humano). */
  fields: ActionField[];
  /** Arma la petición cruda a partir de los campos. `cloudId` se resuelve para Jira. */
  build: (p: Record<string, string>, ctx: { cloudId?: string }) => { method: string; path: string; body?: string };
}

/** Envuelve texto plano en el formato ADF que exige Jira (así el usuario solo escribe texto). */
function adf(text: string): unknown {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

const jiraApi = (cloudId: string | undefined, suffix: string) => `/ex/jira/${cloudId ?? '{cloudid}'}/rest/api/3${suffix}`;

export const CONNECTOR_ACTIONS: Record<string, ConnectorAction[]> = {
  slack: [
    {
      id: 'post-message',
      label: 'Enviar un mensaje a un canal',
      fields: [
        { key: 'channel', label: 'Canal', placeholder: '#general', default: '#general' },
        { key: 'text', label: 'Mensaje', placeholder: 'Escribe el mensaje…', multiline: true },
      ],
      build: (p) => ({ method: 'POST', path: '/chat.postMessage', body: JSON.stringify({ channel: p.channel, text: p.text }) }),
    },
    {
      id: 'add-reaction',
      label: 'Añadir una reacción a un mensaje',
      fields: [
        { key: 'channel', label: 'Canal (ID)', placeholder: 'C0000000000' },
        { key: 'timestamp', label: 'Marca de tiempo del mensaje', placeholder: '1234567890.123456' },
        { key: 'name', label: 'Emoji', placeholder: 'thumbsup', default: 'thumbsup' },
      ],
      build: (p) => ({ method: 'POST', path: '/reactions.add', body: JSON.stringify({ channel: p.channel, timestamp: p.timestamp, name: p.name }) }),
    },
  ],
  jira: [
    {
      id: 'comment',
      label: 'Comentar en el ticket',
      fields: [
        { key: 'issueKey', label: 'Ticket', placeholder: 'KAN-123', default: '{{ticket.key}}' },
        { key: 'comment', label: 'Comentario', placeholder: 'Escribe el comentario…', multiline: true },
      ],
      build: (p, { cloudId }) => ({
        method: 'POST',
        path: jiraApi(cloudId, `/issue/${p.issueKey}/comment`),
        body: JSON.stringify({ body: adf(p.comment) }),
      }),
    },
    {
      id: 'transition',
      label: 'Mover el ticket a otro estado',
      fields: [
        { key: 'issueKey', label: 'Ticket', placeholder: 'KAN-123', default: '{{ticket.key}}' },
        { key: 'transitionId', label: 'ID de la transición', placeholder: '21', default: '21' },
      ],
      build: (p, { cloudId }) => ({
        method: 'POST',
        path: jiraApi(cloudId, `/issue/${p.issueKey}/transitions`),
        body: JSON.stringify({ transition: { id: p.transitionId } }),
      }),
    },
    {
      id: 'create-issue',
      label: 'Crear una incidencia',
      fields: [
        { key: 'projectKey', label: 'Proyecto', placeholder: 'KAN', default: 'KAN' },
        { key: 'summary', label: 'Título', placeholder: 'Resumen de la incidencia', default: '{{ticket.summary}}' },
        { key: 'issueType', label: 'Tipo', placeholder: 'Task', default: 'Task' },
      ],
      build: (p, { cloudId }) => ({
        method: 'POST',
        path: jiraApi(cloudId, '/issue'),
        body: JSON.stringify({ fields: { project: { key: p.projectKey }, summary: p.summary, issuetype: { name: p.issueType } } }),
      }),
    },
  ],
  github: [
    {
      id: 'create-issue',
      label: 'Crear un issue',
      fields: [
        { key: 'owner', label: 'Propietario', placeholder: 'mi-org' },
        { key: 'repo', label: 'Repositorio', placeholder: 'mi-repo' },
        { key: 'title', label: 'Título', placeholder: 'Título del issue' },
        { key: 'body', label: 'Descripción', placeholder: 'Descripción…', multiline: true },
      ],
      build: (p) => ({ method: 'POST', path: `/repos/${p.owner}/${p.repo}/issues`, body: JSON.stringify({ title: p.title, body: p.body }) }),
    },
  ],
  dev: [
    { id: 'whoami', label: 'Quién soy (prueba)', fields: [], build: () => ({ method: 'GET', path: '/whoami' }) },
  ],
};
