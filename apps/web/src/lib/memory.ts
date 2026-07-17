/**
 * Memoria del agente (M81) en lenguaje humano. El motor guarda `agent.memoryScope`; aquí traducimos cada
 * modo a algo que una persona no técnica entienda: QUÉ recuerda y QUIÉN lo comparte.
 *
 * Con memoria encendida el agente (a) arranca recordando lo que concluyó antes y (b) recibe la herramienta
 * «remember» para guardar hechos a propósito. Apagada, no lee ni escribe nada (coste 0).
 */
export interface MemoryMode {
  /** Valor guardado en `agent.memoryScope`; `null` = apagada. */
  value: string | null;
  label: string;
  desc: string;
}

export const MEMORY_MODES: MemoryMode[] = [
  { value: null, label: 'Sin memoria', desc: 'Empieza de cero en cada ejecución.' },
  { value: 'temporal', label: 'Solo esta ejecución', desc: 'Recuerda mientras dura el flujo; al terminar, lo olvida.' },
  { value: 'persistent', label: 'Recuerda siempre', desc: 'Este trabajador recuerda lo suyo entre ejecuciones.' },
  { value: 'shared', label: 'Memoria de equipo', desc: 'Todos los trabajadores del espacio comparten lo que recuerdan.' },
];

export const memoryModeOf = (scope: string | null | undefined): MemoryMode =>
  MEMORY_MODES.find((m) => m.value === (scope ?? null)) ?? MEMORY_MODES[0];

/** ¿Tiene memoria encendida? (cualquier modo distinto de «sin memoria»). */
export const hasMemory = (scope: string | null | undefined): boolean => !!scope && scope !== 'none';
