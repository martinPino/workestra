import { Boxes } from 'lucide-react';
import { siGithub, siNotion, siLinear, siSentry, siAtlassian, siStripe, siHuggingface } from 'simple-icons';
import { mcpPresetFor } from './tools';

/**
 * Logo de un servidor MCP (M42/M44): hace el menú y los sub-nodos más reconocibles. Usa las marcas REALES de
 * `simple-icons` (SVG local, sin CDN — compatible con la CSP de producción), sobre una insignia con el color
 * de marca. DeepWiki/Context7 no están en la librería → caen a la inicial; un MCP personalizado, al icono
 * genérico. Las marcas se usan solo para identificar el servicio (uso nominativo, como n8n).
 */
const BRAND_ICON: Record<string, { path: string }> = {
  GitHub: siGithub,
  Notion: siNotion,
  Linear: siLinear,
  Sentry: siSentry,
  Atlassian: siAtlassian,
  Stripe: siStripe,
  'Hugging Face': siHuggingface,
};

/** Insignia cuadrada con el color de marca (`box` = tamaño del cuadro). */
export function McpLogo({ server, box = 30 }: { server: { url?: string; name?: string }; box?: number }) {
  const preset = mcpPresetFor(server);
  if (!preset) return <Boxes size={Math.round(box * 0.66)} className="text-primary" aria-hidden="true" />;
  const icon = BRAND_ICON[preset.name];
  const mark = preset.darkText ? '#1a1a1a' : '#fff';
  return (
    <span
      className="flex items-center justify-center rounded-lg font-semibold"
      style={{ width: box, height: box, background: preset.color, color: mark, fontSize: Math.round(box * 0.46) }}
      role="img"
      aria-label={preset.name}
    >
      {icon ? (
        <svg viewBox="0 0 24 24" width={Math.round(box * 0.6)} height={Math.round(box * 0.6)} fill={mark} aria-hidden="true">
          <path d={icon.path} />
        </svg>
      ) : (
        preset.name[0].toUpperCase()
      )}
    </span>
  );
}
