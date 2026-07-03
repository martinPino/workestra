import { useUI, type Lang } from '../app/ui-store';
import { EN } from './dict';

/**
 * i18n ligero: el ESPAÑOL es la clave (idioma nativo de la app). `t('texto en español')` devuelve la
 * traducción inglesa si el idioma es `en`, o el propio español si es `es` o si falta la traducción
 * (fallback grácil: nada se rompe, sólo se ve en español). Elegido sobre keys sintéticas para que
 * envolver strings sea mínimamente invasivo y el código siga legible.
 */
export function translate(text: string, lang: Lang): string {
  if (lang === 'es') return text;
  return EN[text] ?? text;
}

/** Hook reactivo: re-renderiza el componente al cambiar de idioma. `const t = useT(); t('Guardar')`. */
export function useT(): (text: string) => string {
  const lang = useUI((s) => s.lang);
  return (text: string) => translate(text, lang);
}
