import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { toSurface } from './session';
import { startTracking, startView, track } from './tracker';

/**
 * Captura AUTOMÁTICA (M84). Va dentro del router porque necesita saber en qué pantalla está.
 *
 * Se encarga de lo que nadie debería tener que acordarse de escribir: la navegación, la permanencia y
 * los clicks marcados. Todo lo específico de una pantalla (abrir una automatización, instalar una
 * plantilla) lo emite esa pantalla con `useAnalytics`.
 */
export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const prev = useRef<string | null>(null);

  useEffect(() => startTracking(), []);

  // Navegación: una vista por cambio de ruta, con la pantalla de la que se venía.
  useEffect(() => {
    const surface = toSurface(pathname);
    track('page.viewed', {
      surface,
      props: prev.current && prev.current !== surface ? { referrerSurface: prev.current } : {},
    });
    startView(surface);
    prev.current = surface;
  }, [pathname]);

  /**
   * Clicks IMPORTANTES, de forma declarativa: solo se registran los elementos marcados con
   * `data-track="algo"`. Así «qué es importante» lo decide quien escribe el botón, en el sitio del
   * botón, en vez de una lista de selectores en otro fichero que se queda vieja a la primera.
   *
   * Una sola escucha delegada en la raíz: ni un listener por botón, ni re-render al pulsar.
   */
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-track]') as HTMLElement | null;
      if (!el) return;
      const element = el.dataset.track;
      if (!element) return;
      track('button.clicked', {
        props: { element },
        entityType: el.dataset.trackEntity as never,
        entityId: el.dataset.trackId,
      });
    };
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true } as EventListenerOptions);
  }, []);

  return <>{children}</>;
}
