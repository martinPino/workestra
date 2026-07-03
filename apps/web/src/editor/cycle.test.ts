import { describe, it, expect } from 'vitest';
import { wouldCreateCycle, CycleIndex } from './cycle';

describe('DAG guard (CycleIndex incremental)', () => {
  it('detecta ciclos directos e indirectos y permite aristas válidas', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    expect(wouldCreateCycle(edges, 'c', 'a')).toBe(true); // cerraría a→b→c→a
    expect(wouldCreateCycle(edges, 'b', 'a')).toBe(true); // cerraría a→b→a
    expect(wouldCreateCycle(edges, 'a', 'c')).toBe(false); // sigue siendo DAG
    expect(wouldCreateCycle(edges, 'a', 'a')).toBe(true); // auto-lazo
  });

  it('cumple el presupuesto de rendimiento con 600 nodos', () => {
    const N = 600;
    const edges: { source: string; target: string }[] = [];
    for (let i = 0; i < N - 1; i++) edges.push({ source: `n${i}`, target: `n${i + 1}` });
    for (let i = 0; i < N; i += 2) edges.push({ source: 'n0', target: `n${i}` });

    const index = new CycleIndex(edges);
    const t0 = performance.now();
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      index.wouldCreateCycle(`n${(i * 3) % N}`, `n${(i * 7) % N}`);
      checked++;
    }
    const ms = performance.now() - t0;
    expect(checked).toBe(300);
    expect(ms).toBeLessThan(200); // presupuesto holgado; en local suele ser << 20ms
  });
});
