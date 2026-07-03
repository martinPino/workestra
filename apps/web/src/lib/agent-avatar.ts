/**
 * Identidad visual del agente. El color se deriva de forma DETERMINISTA del id, así el mismo agente
 * tiene el mismo avatar en la galería de Agentes y en la carta de su nodo en el editor.
 */
export const AGENT_GRADIENTS = [
  'from-indigo-500 to-fuchsia-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-sky-500 to-blue-500',
  'from-rose-500 to-pink-500',
  'from-violet-500 to-purple-500',
];

/** Gradiente estable a partir de una semilla (el id del agente). */
export function agentGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AGENT_GRADIENTS[h % AGENT_GRADIENTS.length];
}

/** Inicial en mayúscula para el avatar (identidad rápida del agente). */
export function agentInitial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}
