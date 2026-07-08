import { describe, it, expect } from 'vitest';
import type { GraphDoc } from './model';
import { ancestorIds, availableVars, unknownRefs, outputsForNode } from './graph-vars';

// Cadena: trigger → descargar(download) → extraer(extract) → llm → conector → fin
const doc: GraphDoc = {
  nodes: [
    { id: 'trigger', kind: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'descargar', kind: 'download', position: { x: 0, y: 0 }, config: {} },
    { id: 'extraer', kind: 'extract', position: { x: 0, y: 0 }, config: {} },
    { id: 'llm', kind: 'llm', position: { x: 0, y: 0 }, config: {} },
    { id: 'conector', kind: 'connector', position: { x: 0, y: 0 }, config: {} },
    { id: 'fin', kind: 'end', position: { x: 0, y: 0 }, config: {} },
  ],
  edges: [
    { id: 'e1', source: 'trigger', target: 'descargar' },
    { id: 'e2', source: 'descargar', target: 'extraer' },
    { id: 'e3', source: 'extraer', target: 'llm' },
    { id: 'e4', source: 'llm', target: 'conector' },
    { id: 'e5', source: 'conector', target: 'fin' },
  ],
  comments: [],
};

describe('ancestorIds', () => {
  it('devuelve los nodos aguas arriba, más cercanos primero', () => {
    expect(ancestorIds(doc, 'conector')).toEqual(['llm', 'extraer', 'descargar', 'trigger']);
    expect(ancestorIds(doc, 'descargar')).toEqual(['trigger']);
    expect(ancestorIds(doc, 'trigger')).toEqual([]);
  });
});

describe('outputsForNode', () => {
  it('mapea cada tipo a su prefijo de salida', () => {
    expect(outputsForNode(doc.nodes[3]).map((v) => v.ref)).toEqual(['agent:llm.output']); // llm
    expect(outputsForNode(doc.nodes[2]).map((v) => v.ref)).toEqual(['text:extraer.text']); // extract
    expect(outputsForNode(doc.nodes[1]).map((v) => v.ref)).toContain('file:descargar.id'); // download
    expect(outputsForNode(doc.nodes[0])).toEqual([]); // trigger no expone por-campo
    expect(outputsForNode(doc.nodes[5])).toEqual([]); // end
  });
});

describe('availableVars', () => {
  it('el conector ve la salida de la IA y del texto extraído (ancestros)', () => {
    const refs = availableVars(doc, 'conector').map((v) => v.ref);
    expect(refs).toContain('agent:llm.output');
    expect(refs).toContain('text:extraer.text');
    expect(refs).toContain('file:descargar.id');
    expect(refs).toContain('file:trigger.id'); // del disparador (siempre)
  });
  it('un nodo NO ve las salidas de nodos que no son sus ancestros', () => {
    const refs = availableVars(doc, 'descargar').map((v) => v.ref);
    expect(refs).not.toContain('agent:llm.output'); // llm está aguas abajo
    expect(refs).not.toContain('text:extraer.text');
  });
});

describe('unknownRefs (el fallo de Slack)', () => {
  const vars = availableVars(doc, 'fin'); // 'fin' ve todos los pasos anteriores, incluido el conector
  it('marca una referencia a un paso inexistente', () => {
    expect(unknownRefs('Hola {{agent:summary.output}}', vars)).toEqual(['agent:summary.output']);
  });
  it('acepta una referencia válida (por raíz, navegando a subcampos)', () => {
    expect(unknownRefs('{{agent:llm.output}}', vars)).toEqual([]);
    expect(unknownRefs('{{connector:conector.json.id}}', vars)).toEqual([]);
    expect(unknownRefs('{{text:extraer.text}}', vars)).toEqual([]);
  });
  it('no marca las variables base del disparador', () => {
    expect(unknownRefs('{{ticket.summary}} {{file:trigger.id}}', vars)).toEqual([]);
  });
  it('texto sin referencias → sin avisos', () => {
    expect(unknownRefs('un mensaje normal sin variables', vars)).toEqual([]);
  });
});
