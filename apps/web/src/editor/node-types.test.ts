import { describe, it, expect } from 'vitest';
import { Puzzle } from 'lucide-react';
import { listNodeTypes, getNodeType, registerNodeType, defaultConfig } from './node-types';

describe('NodeTypeRegistry (schema-driven, incremental)', () => {
  it('los tipos base de M2 están registrados con su config schema', () => {
    const kinds = listNodeTypes().map((t) => t.kind);
    expect(kinds).toEqual(expect.arrayContaining(['trigger', 'tool', 'condition', 'api', 'end']));
    expect(getNodeType('api')?.configSchema.fields.url?.type).toBe('string');
    expect(getNodeType('condition')?.configSchema.fields.expression?.type).toBe('string');
  });

  it('añadir un tipo NUEVO no toca el núcleo: aparece en paleta/panel y aporta sus defaults', () => {
    const before = listNodeTypes().length;
    registerNodeType({
      kind: 'custom-x',
      label: 'Custom X',
      icon: Puzzle,
      color: 'text-pink-400',
      category: 'logic',
      configSchema: {
        title: 'Custom X',
        fields: { retries: { type: 'number', label: 'Reintentos', default: 3 } },
      },
    });
    const after = listNodeTypes();
    expect(after.length).toBe(before + 1);
    expect(after.some((t) => t.kind === 'custom-x')).toBe(true);
    // El panel de propiedades y la paleta se generan desde el registro => cero cambios de código.
    expect(defaultConfig('custom-x')).toEqual({ retries: 3 });
  });
});
