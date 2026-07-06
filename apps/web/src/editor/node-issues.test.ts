import { describe, it, expect } from 'vitest';
import { nodeSetupIssues, graphSetupIssues } from './node-issues';

const connected = [{ id: 'c1', status: 'connected' }];
const disconnected = [{ id: 'c1', status: 'disconnected' }];
const agents = [{ id: 'a1' }];

describe('nodeSetupIssues — conector', () => {
  it('sin connectorId → pide elegir app', () => {
    expect(nodeSetupIssues('connector', {}, {})).toEqual(['Elige a qué app enviar']);
  });

  it('connectorId pero lista aún cargando (undefined) → no inventa avisos', () => {
    expect(nodeSetupIssues('connector', { connectorId: 'c1' }, {})).toEqual([]);
  });

  it('connectorId que no está en la lista cargada → «ya no existe»', () => {
    expect(nodeSetupIssues('connector', { connectorId: 'x' }, { connectors: connected })).toEqual([
      'La app elegida ya no existe: vuelve a elegirla',
    ]);
  });

  it('conector presente pero desconectado → «faltan credenciales»', () => {
    expect(nodeSetupIssues('connector', { connectorId: 'c1' }, { connectors: disconnected })).toEqual([
      'Conecta esta app (faltan credenciales)',
    ]);
  });

  it('conector conectado → sin avisos', () => {
    expect(nodeSetupIssues('connector', { connectorId: 'c1' }, { connectors: connected })).toEqual([]);
  });

  it('lista FALLÓ al cargar (no solo cargando) → avisa y bloquea, no lo da por bueno', () => {
    expect(nodeSetupIssues('connector', { connectorId: 'c1' }, { connectorsError: true })).toEqual([
      'No se pudo comprobar la app (recarga la página)',
    ]);
    // cargando (sin error) sigue sin inventar avisos
    expect(nodeSetupIssues('connector', { connectorId: 'c1' }, { connectorsError: false })).toEqual([]);
  });
});

describe('nodeSetupIssues — agente / repartir', () => {
  it('agente sin elegir → pide elegir asistente', () => {
    expect(nodeSetupIssues('agent', {}, { agents })).toEqual(['Elige un asistente']);
  });

  it('repartir sin agente → pide elegir quién reparte', () => {
    expect(nodeSetupIssues('router', {}, { agents })).toEqual(['Elige quién reparte el trabajo']);
  });

  it('agentId que ya no existe (lista cargada) → «ya no existe»', () => {
    expect(nodeSetupIssues('agent', { agentId: 'zzz' }, { agents })).toEqual([
      'El asistente elegido ya no existe: vuelve a elegirlo',
    ]);
  });

  it('agentId válido → sin avisos', () => {
    expect(nodeSetupIssues('agent', { agentId: 'a1' }, { agents })).toEqual([]);
  });

  it('agentId con lista aún cargando → no inventa «no existe»', () => {
    expect(nodeSetupIssues('agent', { agentId: 'a1' }, {})).toEqual([]);
  });

  it('lista de agentes FALLÓ al cargar → avisa (no lo da por bueno)', () => {
    expect(nodeSetupIssues('agent', { agentId: 'a1' }, { agentsError: true })).toEqual([
      'No se pudo comprobar el asistente (recarga la página)',
    ]);
  });
});

describe('nodeSetupIssues — tipos sin requisitos', () => {
  it('llm/tool/trigger/end no generan avisos', () => {
    for (const kind of ['llm', 'tool', 'trigger', 'end', 'condition', 'wait']) {
      expect(nodeSetupIssues(kind, {}, { agents, connectors: connected })).toEqual([]);
    }
  });
});

describe('graphSetupIssues', () => {
  it('devuelve solo los nodos con problemas, con su id y kind', () => {
    const nodes = [
      { id: 'n1', kind: 'connector', config: {} }, // falta app
      { id: 'n2', kind: 'agent', config: { agentId: 'a1' } }, // ok
      { id: 'n3', kind: 'end', config: {} }, // ok
    ];
    const res = graphSetupIssues(nodes, { agents, connectors: connected });
    expect(res).toEqual([{ nodeId: 'n1', kind: 'connector', issues: ['Elige a qué app enviar'] }]);
  });
});
