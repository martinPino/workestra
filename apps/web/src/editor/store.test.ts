import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from './store';
import { useUI } from '../app/ui-store';
import { emptyDoc } from './model';

/**
 * El texto de una nota es contenido persistido, no UI: se congela en el idioma activo al crearla,
 * así que `addCommentAt` debe traducirlo en ese momento (no hay un `t()` posterior que lo salve).
 */
describe('addCommentAt', () => {
  beforeEach(() => {
    useEditorStore.setState({ history: { doc: emptyDoc(), past: [], future: [] } });
  });

  const textOf = () => useEditorStore.getState().history.doc.comments[0].text;

  it('crea la nota en español cuando el idioma es es', () => {
    useUI.setState({ lang: 'es' });
    useEditorStore.getState().addCommentAt({ x: 0, y: 0 });
    expect(textOf()).toBe('Nueva nota\n- Escribe aquí un punto');
  });

  it('crea la nota en inglés cuando el idioma es en', () => {
    useUI.setState({ lang: 'en' });
    useEditorStore.getState().addCommentAt({ x: 0, y: 0 });
    expect(textOf()).toBe('New note\n- Write a point here');
  });
});
