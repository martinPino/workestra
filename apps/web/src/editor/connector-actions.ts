// Plantillas de acciones por proveedor (UX del nodo Conector). Al elegir una acción se rellenan
// automáticamente `method`, `path` y `body` del nodo — luego el usuario los puede ajustar.
export interface ConnectorAction {
  id: string;
  label: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** Plantilla JSON del cuerpo (string legible). Vacío = sin cuerpo. */
  body?: string;
}

export const CONNECTOR_ACTIONS: Record<string, ConnectorAction[]> = {
  slack: [
    {
      id: 'post-message',
      label: 'Postear mensaje en un canal',
      method: 'POST',
      path: '/chat.postMessage',
      body: '{\n  "channel": "#general",\n  "text": "Hola desde AgentFlow 🚀"\n}',
    },
    { id: 'list-channels', label: 'Listar mis canales', method: 'GET', path: '/users.conversations?types=public_channel&limit=100' },
    {
      id: 'add-reaction',
      label: 'Añadir reacción a un mensaje',
      method: 'POST',
      path: '/reactions.add',
      body: '{\n  "channel": "C0000000000",\n  "timestamp": "1234567890.123456",\n  "name": "thumbsup"\n}',
    },
    { id: 'auth-test', label: 'Quién soy (validar token)', method: 'POST', path: '/auth.test' },
  ],
  jira: [
    { id: 'accessible', label: 'Resolver cloud id (accessible-resources)', method: 'GET', path: '/oauth/token/accessible-resources' },
    {
      id: 'create-issue',
      label: 'Crear incidencia',
      method: 'POST',
      path: '/ex/jira/{cloudid}/rest/api/3/issue',
      body: '{\n  "fields": {\n    "project": { "key": "PROJ" },\n    "summary": "Título de la incidencia",\n    "issuetype": { "name": "Task" }\n  }\n}',
    },
    {
      id: 'search',
      label: 'Buscar incidencias (JQL)',
      method: 'GET',
      path: '/ex/jira/{cloudid}/rest/api/3/search?jql=order%20by%20created%20DESC&maxResults=10',
    },
  ],
  github: [
    { id: 'list-repos', label: 'Listar mis repos', method: 'GET', path: '/user/repos?per_page=20' },
    {
      id: 'create-issue',
      label: 'Crear issue',
      method: 'POST',
      path: '/repos/{owner}/{repo}/issues',
      body: '{\n  "title": "Título del issue",\n  "body": "Descripción"\n}',
    },
  ],
  dev: [{ id: 'whoami', label: 'Whoami (prueba)', method: 'GET', path: '/whoami' }],
};
