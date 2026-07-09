/**
 * Marca de Workestra: tres nodos a la izquierda que CONVERGEN en uno solo a la derecha — la metáfora de
 * orquestar varios agentes en un resultado. Los trazos y los nodos de origen usan `currentColor` para
 * adaptarse al tema (claro/oscuro); el nodo de convergencia lleva el azul de marca. `viewBox` fijo 0..96.
 */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      role="img"
      aria-label="Workestra"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g stroke="currentColor" strokeWidth={6} strokeLinecap="round">
        <path d="M20 24 C 42 26, 54 42, 66 48" />
        <path d="M20 48 H66" />
        <path d="M20 72 C 42 70, 54 54, 66 48" />
      </g>
      <circle cx="20" cy="24" r="6" fill="currentColor" />
      <circle cx="20" cy="48" r="6" fill="currentColor" />
      <circle cx="20" cy="72" r="6" fill="currentColor" />
      <circle cx="72" cy="48" r="9" fill="#4F7CFF" />
    </svg>
  );
}
