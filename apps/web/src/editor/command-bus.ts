import type { GraphDoc } from './model';
import type { Command } from './commands';

/** Pila de comandos con undo/redo determinista. Estado inmutable. */
export interface History {
  doc: GraphDoc;
  past: Command[];
  future: Command[];
}

export const createHistory = (doc: GraphDoc): History => ({ doc, past: [], future: [] });

export function dispatch(h: History, cmd: Command): History {
  return { doc: cmd.redo(h.doc), past: [...h.past, cmd], future: [] };
}

export function undo(h: History): History {
  const cmd = h.past[h.past.length - 1];
  if (!cmd) return h;
  return { doc: cmd.undo(h.doc), past: h.past.slice(0, -1), future: [cmd, ...h.future] };
}

export function redo(h: History): History {
  const cmd = h.future[0];
  if (!cmd) return h;
  return { doc: cmd.redo(h.doc), past: [...h.past, cmd], future: h.future.slice(1) };
}

export const canUndo = (h: History) => h.past.length > 0;
export const canRedo = (h: History) => h.future.length > 0;
