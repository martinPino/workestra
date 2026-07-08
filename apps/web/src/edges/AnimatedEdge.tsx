import { memo } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from 'reactflow';
import type { FlowEdgeData } from '../graph';

/**
 * Arista con «luz viajera» (M65, estilo n8n). Durante una ejecución:
 *  - active: un haz azul eléctrico recorre la curva del origen al destino → la info «viaja».
 *  - traversed: la arista ya recorrida conserva una estela tenue → se reconstruye el camino.
 *  - reposo: línea sutil como siempre (mismo bézier que la arista por defecto → sin saltos visuales).
 *
 * Rendimiento: la curva base siempre es un único <path>; SOLO las aristas activas montan el haz
 * animado + glow. La animación es CSS (compositor), sin estado React ni rAF por fotograma → escala
 * a flujos de +200 nodos porque el coste crece con las aristas ACTIVAS a la vez (0-2 típicamente),
 * no con el total.
 */
function AnimatedEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<FlowEdgeData>) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const active = !!data?.active;
  const traversed = !!data?.traversed;
  const stroke = active
    ? 'rgb(var(--flow) / 0.5)'
    : traversed
      ? 'rgb(var(--flow) / 0.3)'
      : 'rgb(var(--border-strong))';
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ stroke, strokeWidth: active || traversed ? 2 : 1.5, transition: 'stroke 250ms ease' }}
      />
      {/* pathLength={100} normaliza el patrón de guiones a la longitud de ESTA curva → un único haz
          recorre toda la arista una vez, sea corta o larga (evita varios haces en aristas largas). */}
      {active && <path d={edgePath} className="af-flow-line" fill="none" pathLength={100} />}
    </>
  );
}

export const AnimatedEdge = memo(AnimatedEdgeImpl);
