import { describe, it, expect } from 'vitest';
import type { Agent, WorkflowGraph } from '@core/contracts';
import { sanitizeWorkflowForShare } from './sanitize';

const agent = (over: Partial<Agent>): Agent => ({
  id: 'ag_1',
  name: 'Editor',
  description: 'Redacta',
  systemPrompt: 'Eres un editor.',
  model: 'gpt-5',
  tools: [],
  mcpServers: null,
  memoryScope: null,
  variables: null,
  limits: null,
  permissions: null,
  isOrchestrator: false,
  ...over,
});

const graph = (nodes: WorkflowGraph['nodes']): WorkflowGraph => ({ nodes, edges: [] });

describe('sanitizeWorkflowForShare — NINGÚN secreto puede salir en el enlace (M85)', () => {
  it('planta secretos por todas partes y confirma que NO aparecen en el documento compartido', () => {
    const g = graph([
      { key: 'trigger', type: 'trigger', config: { event: 'cron', eventId: 'google-drive.file_created', folderId: '1_CARPETA_PRIVADA' }, position: { x: 0, y: 0 } },
      { key: 'news', type: 'api', config: { method: 'GET', url: 'https://api.x.com/v2?apiKey=PLANTED_QUERY_KEY', headers: '{"X-Api-Key":"PLANTED_HEADER_KEY_af_abcdefghijklmnop"}' }, position: { x: 1, y: 0 } },
      { key: 'digest', type: 'llm', config: { model: 'gpt-5', prompt: 'Resume esto. Usa la clave sk-live-PLANTEDABCDEFGHIJ para autenticar.', input: '{{http:news.json}}' }, position: { x: 2, y: 0 } },
      { key: 'sheet', type: 'connector', config: { connectorId: 'ckPLANTEDCONNECTOR', provider: 'google-sheets', actionParams: '{"spreadsheetId":"1SHEET_PRIVADO"}' }, position: { x: 3, y: 0 } },
    ]);
    const ag = agent({
      id: 'ag_1',
      systemPrompt: 'Eres un editor. Mi token es xoxb-PLANTEDSLACKTOKEN123 no lo pierdas.',
      mcpServers: [{ id: 's1', name: 'GitHub', url: 'https://user:PLANTEDMCPSECRET@mcp.acme.com/sse?key=PLANTEDMCPKEY' }],
    });
    // El nodo digest referencia al agente por config.agentId en algunos flujos; aquí lo probamos por nodo agent:
    const g2 = graph([...g.nodes, { key: 'redactor', type: 'agent', config: { agentId: 'ag_1', input: 'hazlo' }, position: { x: 4, y: 0 } }]);

    const { doc, report } = sanitizeWorkflowForShare({ workflow: { name: 'Mi flujo', graph: g2 }, agents: [ag] });
    const json = JSON.stringify(doc);

    // La prueba que sostiene toda la feature: ninguno de los secretos plantados sobrevive.
    for (const secreto of [
      'PLANTED_HEADER_KEY',
      'af_abcdefghijklmnop',
      'PLANTED_QUERY_KEY',
      'sk-live-PLANTEDABCDEFGHIJ',
      'ckPLANTEDCONNECTOR',
      '1SHEET_PRIVADO',
      'xoxb-PLANTEDSLACKTOKEN123',
      'PLANTEDMCPSECRET',
      'PLANTEDMCPKEY',
      '1_CARPETA_PRIVADA',
    ]) {
      expect(json, `se escapó: ${secreto}`).not.toContain(secreto);
    }

    // Y confirma que la ESTRUCTURA sí viaja (sirve como plantilla).
    expect(doc.name).toBe('Mi flujo');
    expect(doc.graph.nodes.map((n) => n.type)).toContain('llm');
    expect(doc.agents[0].name).toBe('Editor'); // el agente viaja, con su rol
    expect(report.willShare.agentCount).toBe(1);
    expect(report.redactionCount).toBeGreaterThan(0); // se redactaron secretos de los prompts
    expect(report.structuralStrip.length).toBeGreaterThan(0); // se quitaron cabeceras/connector/carpeta/mcp
  });

  it('las cabeceras de un nodo api se quitan SIEMPRE, aunque no parezcan secretas', () => {
    const { doc } = sanitizeWorkflowForShare({
      workflow: { name: 'x', graph: graph([{ key: 'a', type: 'api', config: { method: 'GET', url: 'https://x.com', headers: '{"Accept":"application/json"}' }, position: { x: 0, y: 0 } }]) },
      agents: [],
    });
    expect(JSON.stringify(doc)).not.toContain('headers');
  });

  it('el prompt del agente VIAJA (redactado si lleva un secreto, pero el texto útil se conserva)', () => {
    const { doc } = sanitizeWorkflowForShare({
      workflow: { name: 'x', graph: graph([{ key: 'a', type: 'agent', config: { agentId: 'ag_1' }, position: { x: 0, y: 0 } }]) },
      agents: [agent({ systemPrompt: 'Eres analista. Clave: sk-PLANTEDXXXXXXXXXXXXXXXX. Analiza bien.' })],
    });
    expect(doc.agents[0].systemPrompt).toContain('Eres analista');
    expect(doc.agents[0].systemPrompt).toContain('Analiza bien');
    expect(doc.agents[0].systemPrompt).not.toContain('sk-PLANTED');
    expect(doc.agents[0].systemPrompt).toContain('SECRETO_REDACTADO');
  });

  it('una clave de config DESCONOCIDA se cae (allowlist, no denylist)', () => {
    const { doc } = sanitizeWorkflowForShare({
      workflow: { name: 'x', graph: graph([{ key: 'a', type: 'llm', config: { model: 'gpt-5', prompt: 'hola', campoNuevoConSecreto: 'af_secretito_futuro_xxxxxxxx' }, position: { x: 0, y: 0 } }]) },
      agents: [],
    });
    expect(JSON.stringify(doc)).not.toContain('campoNuevoConSecreto');
    expect(JSON.stringify(doc)).not.toContain('af_secretito_futuro');
    // pero lo permitido sí:
    expect(doc.graph.nodes[0].config.prompt).toBe('hola');
  });

  it('un blob de baja confianza BLOQUEA la creación (no se comparte hasta arreglarlo)', () => {
    const { report } = sanitizeWorkflowForShare({
      workflow: { name: 'x', graph: graph([{ key: 'a', type: 'llm', config: { model: 'gpt-5', prompt: 'usa esto: aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmxvYg==' }, position: { x: 0, y: 0 } }]) },
      agents: [],
    });
    expect(report.canCreate).toBe(false);
    expect(report.blocking.length).toBeGreaterThan(0);
  });

  it('el escaneo es SIN ESTADO: el mismo blob bloquea en llamadas consecutivas (vista previa + crear)', () => {
    // El bug: un regex `/g` con `.test()` arrastra lastIndex y daba true/false/true. La vista previa y la
    // creación son dos llamadas seguidas; con estado, la creación NO detectaba lo que la previa sí marcó.
    const wf = () => ({
      workflow: { name: 'x', graph: graph([{ key: 'a', type: 'llm', config: { model: 'gpt-5', prompt: 'usa esto: aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmxvYjEyMzQ1' }, position: { x: 0, y: 0 } }]) },
      agents: [] as Agent[],
    });
    for (let i = 0; i < 4; i++) {
      expect(sanitizeWorkflowForShare(wf()).report.canCreate, `llamada ${i}`).toBe(false);
    }
  });

  it('redacta TODAS las apariciones de una clave, no solo la primera', () => {
    const { doc } = sanitizeWorkflowForShare({
      workflow: { name: 'x', graph: graph([{ key: 'a', type: 'llm', config: { model: 'gpt-5', prompt: 'clave1 sk-PLANTEDAAAAAAAAAAAAAAAA y clave2 sk-PLANTEDBBBBBBBBBBBBBBBB fin' }, position: { x: 0, y: 0 } }]) },
      agents: [],
    });
    expect(JSON.stringify(doc)).not.toContain('sk-PLANTEDA');
    expect(JSON.stringify(doc)).not.toContain('sk-PLANTEDB');
  });

  it('un flujo sin secretos se comparte sin bloqueos ni redacciones', () => {
    const { report } = sanitizeWorkflowForShare({
      workflow: { name: 'x', graph: graph([{ key: 'a', type: 'llm', config: { model: 'gpt-5', prompt: 'Resume el texto de forma clara.' }, position: { x: 0, y: 0 } }]) },
      agents: [],
    });
    expect(report.canCreate).toBe(true);
    expect(report.blocking).toEqual([]);
    expect(report.redactionCount).toBe(0);
  });

  it('las referencias {{…}} NO son secretos (no disparan falsos positivos)', () => {
    const { report } = sanitizeWorkflowForShare({
      workflow: { name: 'x', graph: graph([{ key: 'a', type: 'llm', config: { model: 'gpt-5', prompt: 'Procesa {{http:news.json.articles}} y responde.' }, position: { x: 0, y: 0 } }]) },
      agents: [],
    });
    expect(report.canCreate).toBe(true);
    expect(report.redactionCount).toBe(0);
  });

  it('un secreto dentro de un body-OBJETO (no string) también se redacta, no viaja verbatim', () => {
    // El bug: el escaneo estaba condicionado a `typeof val === 'string'`, pero el body de un nodo api suele ser
    // un OBJETO JSON. Un token pegado ahí saltaba el escáner por completo y viajaba al enlace público.
    const { doc, report } = sanitizeWorkflowForShare({
      workflow: {
        name: 'x',
        graph: graph([
          {
            key: 'a',
            type: 'api',
            config: {
              method: 'POST',
              url: 'https://api.x.com/send',
              body: { auth: 'Bearer af_livedeadbeef0123456789ABCDEF', payload: { nested: 'sk-ant-PLANTEDdeep1234567890abcd' } },
            },
            position: { x: 0, y: 0 },
          },
        ]),
      },
      agents: [],
    });
    const json = JSON.stringify(doc);
    expect(json, 'clave af_ en el body-objeto').not.toContain('af_livedeadbeef0123456789ABCDEF');
    expect(json, 'clave sk- anidada en el body-objeto').not.toContain('sk-ant-PLANTEDdeep1234567890abcd');
    // La estructura del body limpio se conserva: las claves siguen, con el valor redactado.
    const body = doc.graph.nodes[0].config.body as { auth: string; payload: { nested: string } };
    expect(body.auth).toContain('SECRETO_REDACTADO');
    expect(body.payload.nested).toContain('SECRETO_REDACTADO');
    expect(report.redactionCount).toBeGreaterThanOrEqual(2);
  });

  it('un secreto en el PATH de la URL (no en la query) se redacta', () => {
    const { doc } = sanitizeWorkflowForShare({
      workflow: {
        name: 'x',
        graph: graph([{ key: 'a', type: 'api', config: { method: 'GET', url: 'https://api.example.com/v1/sk-ant-PATHSECRET1234567890abcd/run' }, position: { x: 0, y: 0 } }]),
      },
      agents: [],
    });
    expect(JSON.stringify(doc)).not.toContain('sk-ant-PATHSECRET1234567890abcd');
    expect(doc.graph.nodes[0].config.url).toContain('SECRETO_REDACTADO');
  });

  it('un token con forma desconocida en el PATH (p.ej. bot de Telegram) BLOQUEA la creación', () => {
    const { report } = sanitizeWorkflowForShare({
      workflow: {
        name: 'x',
        graph: graph([{ key: 'a', type: 'api', config: { method: 'POST', url: 'https://api.telegram.org/bot7712345678:AAFrealbotsecrettokenABCDEF123456/sendMessage' }, position: { x: 0, y: 0 } }]),
      },
      agents: [],
    });
    expect(report.canCreate).toBe(false);
    expect(report.blocking.map((b) => b.location)).toContain('a.url');
  });

  it('un secreto pegado en el NOMBRE del flujo o en el nombre/rol del agente no viaja (se escanea)', () => {
    const { doc, report } = sanitizeWorkflowForShare({
      workflow: {
        name: 'Flujo af_livedeadbeef0123456789ABCDEF',
        graph: graph([{ key: 'a', type: 'agent', config: { agentId: 'ag_1' }, position: { x: 0, y: 0 } }]),
      },
      agents: [agent({ name: 'Bot sk-ant-NAMESECRET1234567890abcd', description: 'rol con xoxb-PLANTEDSLACK123456 dentro' })],
    });
    const json = JSON.stringify(doc);
    expect(json).not.toContain('af_livedeadbeef0123456789ABCDEF');
    expect(json).not.toContain('sk-ant-NAMESECRET1234567890abcd');
    expect(json).not.toContain('xoxb-PLANTEDSLACK123456');
    expect(report.contentRedactions.map((r) => r.location)).toEqual(
      expect.arrayContaining(['workflow.name', 'agent_0.name', 'agent_0.role']),
    );
  });

  it('es determinista y no muta la entrada', () => {
    const g = graph([{ key: 'a', type: 'agent', config: { agentId: 'ag_1' }, position: { x: 0, y: 0 } }]);
    const input = { workflow: { name: 'x', graph: g }, agents: [agent({})] };
    const a = sanitizeWorkflowForShare(input);
    const b = sanitizeWorkflowForShare(input);
    expect(JSON.stringify(a.doc)).toBe(JSON.stringify(b.doc));
    expect(g.nodes[0].config).toEqual({ agentId: 'ag_1' }); // no se tocó la entrada
  });
});
