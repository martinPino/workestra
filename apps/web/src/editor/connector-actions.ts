// Acciones NOMBRADAS por proveedor (M20). Cada acción declara sus campos amigables (canal, texto, ticket…)
// y una función `build` que arma method/path/body por debajo — el usuario nunca ve rutas, JSON ni ADF de
// Jira. El executor sigue leyendo method/path/body, así que el runtime no cambia.

export interface ActionField {
  key: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  default?: string;
  /**
   * Fuente de un DESPLEGABLE con datos reales del proveedor (M57), en vez de un campo de texto/insertor de
   * variables. `slack-channel` → canales del Slack conectado; `sentry-project` → proyectos del Sentry conectado.
   */
  source?: 'slack-channel' | 'sentry-project';
  /**
   * Muestra el insertor «+ Insertar dato de un paso» (M58): SOLO en campos de CONTENIDO/referencia (mensaje,
   * comentario, título…), no en identificadores (canal, ID de hoja, emoji…) donde no tiene sentido.
   */
  insert?: boolean;
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
function adf(text: string | undefined): unknown {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text ?? '') }] }] };
}

const jiraApi = (cloudId: string | undefined, suffix: string) => `/ex/jira/${cloudId ?? '{cloudid}'}/rest/api/3${suffix}`;

export const CONNECTOR_ACTIONS: Record<string, ConnectorAction[]> = {
  slack: [
    {
      id: 'post-message',
      label: 'Enviar un mensaje a un canal',
      fields: [
        { key: 'channel', label: 'Canal', placeholder: '#general', source: 'slack-channel' },
        { key: 'text', label: 'Mensaje', placeholder: 'Escribe el mensaje…', multiline: true, insert: true },
      ],
      build: (p) => ({ method: 'POST', path: '/chat.postMessage', body: JSON.stringify({ channel: p.channel, text: p.text }) }),
    },
    // «Añadir una reacción» retirada (M58): exige el channel ID y el timestamp del mensaje, datos que un
    // usuario no-dev no tiene de dónde sacar. Se reintroducirá cuando haya un disparador de Slack que
    // provea ese `ts` (y entonces el timestamp saldrá de un paso anterior, no a mano).
  ],
  jira: [
    {
      id: 'comment',
      label: 'Comentar en el ticket',
      fields: [
        { key: 'issueKey', label: 'Ticket', placeholder: 'KAN-123', default: '{{ticket.key}}', insert: true },
        { key: 'comment', label: 'Comentario', placeholder: 'Escribe el comentario…', multiline: true, insert: true },
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
        { key: 'issueKey', label: 'Ticket', placeholder: 'KAN-123', default: '{{ticket.key}}', insert: true },
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
        { key: 'summary', label: 'Título', placeholder: 'Resumen de la incidencia', default: '{{ticket.summary}}', insert: true },
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
        { key: 'title', label: 'Título', placeholder: 'Título del issue', insert: true },
        { key: 'body', label: 'Descripción', placeholder: 'Descripción…', multiline: true, insert: true },
      ],
      build: (p) => ({ method: 'POST', path: `/repos/${p.owner}/${p.repo}/issues`, body: JSON.stringify({ title: p.title, body: p.body }) }),
    },
  ],
  'google-sheets': [
    {
      id: 'append-row',
      label: 'Añadir una fila',
      fields: [
        { key: 'spreadsheetId', label: 'ID de la hoja de cálculo', placeholder: '1AbC…  (está en la URL de la hoja)' },
        { key: 'range', label: 'Pestaña y celda', placeholder: 'Hoja 1!A1', default: 'A1' },
        { key: 'values', label: 'Valores de la fila (separa columnas con | )', placeholder: '{{ticket.key}} | {{ticket.summary}} | nuevo', multiline: true, insert: true },
      ],
      build: (p) => ({
        method: 'POST',
        path: `/spreadsheets/${p.spreadsheetId}/values/${encodeURIComponent(p.range || 'A1')}:append?valueInputOption=USER_ENTERED`,
        // Se separa por columnas en el editor; cada celda conserva sus {{datos}} y se interpola al ejecutar.
        body: JSON.stringify({ values: [(p.values ?? '').split('|').map((s) => s.trim())] }),
      }),
    },
  ],
  gmail: [
    {
      id: 'send-email',
      label: 'Enviar un correo',
      fields: [
        { key: 'to', label: 'Para', placeholder: 'persona@empresa.com', insert: true },
        { key: 'subject', label: 'Asunto', placeholder: 'Ticket {{ticket.key}}', insert: true },
        { key: 'text', label: 'Mensaje', placeholder: 'Escribe el correo…', multiline: true, insert: true },
      ],
      // El executor de Gmail transforma {to,subject,text} al formato RFC822/base64 que exige la API (M28).
      build: (p) => ({ method: 'POST', path: '/users/me/messages/send', body: JSON.stringify({ to: p.to, subject: p.subject, text: p.text }) }),
    },
    {
      id: 'list-recent',
      label: 'Buscar correos recientes (de la bandeja de entrada)',
      fields: [{ key: 'count', label: 'Cuántos', placeholder: '3', default: '3' }],
      // Devuelve los IDs de los N correos más recientes de INBOX. El JSON queda en {{connector:nodo.json.messages}}
      // para leer cada uno con la acción «Leer un correo».
      build: (p) => ({ method: 'GET', path: `/users/me/messages?maxResults=${p.count || '3'}&labelIds=INBOX` }),
    },
    {
      id: 'get-message',
      label: 'Leer un correo (por ID)',
      fields: [{ key: 'messageId', label: 'ID del correo', placeholder: '{{connector:buscar.json.messages.0.id}}', insert: true }],
      // format=metadata + cabeceras: devuelve remitente/asunto/fecha + un fragmento del cuerpo (snippet).
      build: (p) => ({
        method: 'GET',
        path: `/users/me/messages/${p.messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      }),
    },
  ],
  'google-calendar': [
    {
      id: 'create-event',
      label: 'Crear un evento',
      fields: [
        { key: 'summary', label: 'Título', placeholder: 'Reunión de seguimiento', default: '{{ticket.summary}}', insert: true },
        { key: 'start', label: 'Inicio', placeholder: '2026-01-15T09:00:00', default: '2026-01-15T09:00:00' },
        { key: 'end', label: 'Fin', placeholder: '2026-01-15T10:00:00', default: '2026-01-15T10:00:00' },
        { key: 'timeZone', label: 'Zona horaria', placeholder: 'Europe/Madrid', default: 'UTC' },
      ],
      // Google exige timeZone (o un offset en dateTime); sin ella la API responde 400. Default UTC.
      build: (p) => ({
        method: 'POST',
        path: '/calendars/primary/events',
        body: JSON.stringify({
          summary: p.summary,
          start: { dateTime: p.start, timeZone: p.timeZone || 'UTC' },
          end: { dateTime: p.end, timeZone: p.timeZone || 'UTC' },
        }),
      }),
    },
  ],
  salesforce: [
    {
      id: 'query',
      label: 'Consultar registros (SOQL)',
      fields: [{ key: 'soql', label: 'Consulta SOQL', placeholder: 'SELECT Id, Name FROM Account LIMIT 10', multiline: true, insert: true }],
      build: (p) => ({ method: 'GET', path: `/services/data/v60.0/query?q=${encodeURIComponent(p.soql ?? '')}` }),
    },
    {
      id: 'create-record',
      label: 'Crear un registro',
      fields: [
        { key: 'object', label: 'Objeto', placeholder: 'Account · Contact · Opportunity · Lead', default: 'Account' },
        { key: 'fields', label: 'Campos (JSON · admite {{variables}})', placeholder: '{"Name":"{{code:datos.output.name}}"}', multiline: true, insert: true },
      ],
      build: (p) => ({ method: 'POST', path: `/services/data/v60.0/sobjects/${p.object || 'Account'}`, body: p.fields || '{}' }),
    },
    {
      id: 'update-record',
      label: 'Actualizar un registro',
      fields: [
        { key: 'object', label: 'Objeto', placeholder: 'Opportunity', default: 'Account' },
        { key: 'id', label: 'Id del registro', placeholder: '006XXXXXXXXXXXX', insert: true },
        { key: 'fields', label: 'Campos a cambiar (JSON · admite {{variables}})', placeholder: '{"StageName":"Closed Won"}', multiline: true, insert: true },
      ],
      build: (p) => ({ method: 'PATCH', path: `/services/data/v60.0/sobjects/${p.object || 'Account'}/${p.id}`, body: p.fields || '{}' }),
    },
  ],
  'google-drive': [
    {
      id: 'list-files',
      label: 'Listar ficheros',
      fields: [{ key: 'query', label: 'Filtro (opcional · sintaxis Drive)', placeholder: "'FOLDER_ID' in parents and mimeType='application/pdf'" }],
      build: (p) => ({ method: 'GET', path: `/drive/v3/files${p.query ? `?q=${encodeURIComponent(p.query)}` : ''}` }),
    },
    {
      id: 'create-folder',
      label: 'Crear una carpeta',
      fields: [
        { key: 'name', label: 'Nombre', placeholder: 'Facturas procesadas', insert: true },
        { key: 'parentId', label: 'Carpeta padre (Id, opcional)', placeholder: '1AbC…' },
      ],
      build: (p) => ({
        method: 'POST',
        path: '/drive/v3/files',
        body: JSON.stringify({ name: p.name, mimeType: 'application/vnd.google-apps.folder', ...(p.parentId ? { parents: [p.parentId] } : {}) }),
      }),
    },
  ],
  sentry: [
    {
      id: 'list-issues',
      label: 'Listar issues de un proyecto',
      fields: [
        { key: 'project', label: 'Proyecto', placeholder: 'org/proyecto', source: 'sentry-project' },
        { key: 'query', label: 'Filtro (opcional · sintaxis Sentry)', placeholder: 'is:unresolved', default: 'is:unresolved' },
      ],
      // El JSON queda en {{connector:nodo.json}} (array de issues) para leer cada uno o avisar.
      build: (p) => ({ method: 'GET', path: `/projects/${p.project}/issues/?query=${encodeURIComponent(p.query || 'is:unresolved')}&sort=new&limit=25` }),
    },
    {
      id: 'get-issue',
      label: 'Ver un issue (detalle)',
      fields: [{ key: 'issueId', label: 'ID del issue', placeholder: '{{issue.id}}', default: '{{issue.id}}', insert: true }],
      build: (p) => ({ method: 'GET', path: `/issues/${p.issueId}/` }),
    },
    {
      id: 'get-issue-logs',
      label: 'Ver los logs completos de un issue (último evento)',
      fields: [{ key: 'issueId', label: 'ID del issue', placeholder: '{{issue.id}}', default: '{{issue.id}}', insert: true }],
      // El último evento trae la excepción + stacktrace + breadcrumbs (los «logs completos» del error).
      build: (p) => ({ method: 'GET', path: `/issues/${p.issueId}/events/latest/` }),
    },
  ],
  dev: [
    { id: 'whoami', label: 'Quién soy (prueba)', fields: [], build: () => ({ method: 'GET', path: '/whoami' }) },
  ],
};
