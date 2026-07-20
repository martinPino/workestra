import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toSurface } from './session';
import { setEnabled, startTracking, startView, track } from './tracker';

const API = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');

/**
 * Captura AUTOMÁTICA (M84). Va dentro del router porque necesita saber en qué pantalla está.
 *
 * Se encarga de lo que nadie debería tener que acordarse de escribir: la navegación, la permanencia y
 * los clicks marcados. Todo lo específico de una pantalla (abrir una automatización, instalar una
 * plantilla) lo emite esa pantalla con `useAnalytics`.
 *
 * INTERRUPTOR: lo primero que hace es preguntarle al servidor si la analítica está encendida. Hasta que
 * responda que sí, no se emite nada ni se escucha nada. Si la consulta falla, se queda APAGADO: ante la
 * duda, no se recogen datos de nadie.
 */
export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const prev = useRef<string | null>(null);
  const [on, setOn] = useState(false);

  // Una sola consulta por carga de página. `no-store` para que apagar el interruptor no se quede pegado
  // en la caché del navegador de alguien durante horas.
  useEffect(() => {
    let vivo = true;
    fetch(`${API}/ingest/config`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ enabled?: boolean }>) : { enabled: false }))
      .catch(() => ({ enabled: false }))
      .then((cfg) => {
        if (!vivo) return;
        const activo = cfg.enabled === true;
        setEnabled(activo);
        setOn(activo);
      });
    return () => {
      vivo = false;
      setEnabled(false);
    };
  }, []);

  useEffect(() => {
    if (!on) return undefined;
    return startTracking();
  }, [on]);

  // Navegación: una vista por cambio de ruta, con la pantalla de la que se venía.
  useEffect(() => {
    if (!on) return;
    const surface = toSurface(pathname);
    track('page.viewed', {
      surface,
      props: prev.current && prev.current !== surface ? { referrerSurface: prev.current } : {},
    });
    startView(surface);
    prev.current = surface;
  }, [pathname, on]);

  /**
   * Clicks IMPORTANTES, de forma declarativa: solo se registran los elementos marcados con
   * `data-track="algo"`. Así «qué es importante» lo decide quien escribe el botón, en el sitio del
   * botón, en vez de una lista de selectores en otro fichero que se queda vieja a la primera.
   *
   * Una sola escucha delegada en la raíz: ni un listener por botón, ni re-render al pulsar. Con el
   * interruptor apagado no se registra ni la escucha.
   */
  useEffect(() => {
    if (!on) return undefined;
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
  }, [on]);

  return <>{children}</>;
}
