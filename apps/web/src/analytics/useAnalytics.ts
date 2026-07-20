import { useCallback, useEffect, useRef } from 'react';
import type { EntityType, ErrorKind, EventName, Surface } from '@core/contracts';
import { hashQuery, lenBucket, startView, track } from './tracker';
import { toSurface } from './session';

/**
 * `useAnalytics()` (M84): lo que una pantalla usa para contar lo suyo.
 *
 * La navegación y la permanencia ya las captura `AnalyticsProvider` solo; esto es para lo que solo sabe
 * la pantalla: qué se abrió, qué se instaló, qué se buscó.
 *
 * Ninguna de estas funciones acepta texto libre. No es una recomendación: es que los tipos no lo
 * permiten. `trackError` no recibe un `Error` ni un mensaje, y `trackSearch` no guarda lo tecleado.
 */
export function useAnalytics() {
  /** Evento con nombre del catálogo. Para lo que no encaje, `trackCustom`. */
  const trackEvent = useCallback(
    (
      name: EventName,
      opts: { entityType?: EntityType; entityId?: string; surface?: Surface; tab?: string; props?: Record<string, unknown> } = {},
    ) => track(name, opts),
    [],
  );

  /** Cambio de pantalla a mano (rara vez hace falta: el proveedor ya lo hace por ruta). */
  const trackPage = useCallback((surface?: Surface) => {
    const s = surface ?? toSurface(location.pathname);
    track('page.viewed', { surface: s });
    startView(s);
  }, []);

  /**
   * Cambio de pestaña DENTRO de una pantalla. Cierra el tiempo de la pestaña anterior y abre el de la
   * nueva, que es lo que permite responder «¿en qué pestaña se queda la gente?».
   */
  const trackTab = useCallback((tab: string, from?: string) => {
    track('tab.changed', { tab, props: from ? { from } : {} });
    startView(toSurface(location.pathname), tab);
  }, []);

  /** Click importante. Normalmente NO hace falta: basta con poner `data-track` en el elemento. */
  const trackClick = useCallback((element: string, opts: { entityType?: EntityType; entityId?: string } = {}) => {
    track('button.clicked', { props: { element }, ...opts });
  }, []);

  /**
   * Error visto por quien usa el producto. Fíjate en la firma: NO admite un `Error` ni un texto.
   *
   * El mensaje de error es la vía de fuga clásica —el cliente construye «HTTP 400: <cuerpo del
   * servidor>» y ahí dentro han viajado valores de un grafo y trozos de prompt—. Aquí solo entra un
   * código corto. Si no hay código, se manda `unknown` con el estado HTTP: un montón de errores
   * «unknown» es una tarea pendiente; un montón de prompts filtrados es un incidente.
   */
  const trackError = useCallback((input: { kind: ErrorKind; code: string; httpStatus?: number }) => {
    track('error.displayed', {
      props: {
        kind: input.kind,
        code: (input.code || 'unknown').toLowerCase().replace(/[^a-z0-9._:-]/g, '-').slice(0, 64),
        ...(input.httpStatus ? { httpStatus: input.httpStatus } : {}),
      },
    });
  }, []);

  /**
   * Búsqueda: cuántas letras, cuántos resultados y un hash para poder correlacionar — nunca el texto.
   * Devuelve el hash para poder enlazar después la selección con la búsqueda que la originó.
   */
  const trackSearch = useCallback(
    async (scope: SearchScope, query: string, resultCount: number): Promise<string> => {
      const q = query.trim();
      const queryHash = await hashQuery(q);
      track('search.performed', {
        props: {
          scope,
          queryHash,
          queryLenBucket: lenBucket(q.length),
          tokenCount: Math.min(32, q.split(/\s+/).filter(Boolean).length),
          resultCount: Math.max(0, Math.min(100_000, Math.round(resultCount))),
        },
      });
      return queryHash;
    },
    [],
  );

  /** Qué resultado se eligió y cuánto se tardó: mide si el buscador acierta a la primera. */
  const trackSearchSelected = useCallback((scope: SearchScope, queryHash: string, timeToSelectMs: number, selectedRank: number) => {
    track('search.selected', {
      props: {
        scope,
        queryHash,
        timeToSelectMs: Math.max(0, Math.min(600_000, Math.round(timeToSelectMs))),
        selectedRank: Math.max(0, Math.min(1000, Math.round(selectedRank))),
      },
    });
  }, []);

  /** Evento propio, con clave acotada. El escape con correa. */
  const trackCustom = useCallback((key: string, value?: string | number | boolean) => {
    track('custom', {
      props: {
        key: key.toLowerCase().replace(/[^a-z0-9._:-]/g, '-').slice(0, 64),
        ...(value === undefined ? {} : { value: typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9._:-]/g, '-').slice(0, 64) : value }),
      },
    });
  }, []);

  return { trackEvent, trackPage, trackTab, trackClick, trackError, trackSearch, trackSearchSelected, trackCustom };
}

export type SearchScope = 'marketplace' | 'command-palette' | 'workflows' | 'agents' | 'executions';

/**
 * Marca la pestaña activa de una pantalla con pestañas y mide su tiempo. Un `useEffect` en la pantalla
 * y ya: el tiempo de la pestaña anterior se cierra solo al cambiar.
 */
export function useTabTracking(tab: string | undefined): void {
  const prev = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!tab || prev.current === tab) return;
    track('tab.changed', { tab, props: prev.current ? { from: prev.current } : {} });
    startView(toSurface(location.pathname), tab);
    prev.current = tab;
  }, [tab]);
}

/** Abrir una entidad (automatización, trabajador, conector…) en una sola línea. */
export function trackOpened(name: EventName, entityType: EntityType, entityId?: string): void {
  track(name, { entityType, entityId });
}
