/**
 * Logos de marca de los proveedores de conectores (M27), como marcas SVG INLINE (sin CDN: la CSP de
 * producción bloquea recursos externos). Hacen el editor más reconocible (estilo n8n): un nodo «Enviar a
 * Slack» muestra el logo de Slack, no un enchufe genérico.
 *
 * Marcas oficiales simplificadas. GitHub va monocromo (`currentColor`) para adaptarse a claro/oscuro; Slack
 * y Jira llevan sus colores de marca. Quien no tenga logo (p. ej. `dev`) usa el icono genérico del que llama.
 */

import { siGoogledrive, siSentry } from 'simple-icons';

const WITH_LOGO = new Set([
  'slack',
  'jira',
  'github',
  'google-sheets',
  'gmail',
  'google-calendar',
  'google-drive',
  'salesforce',
  'stripe',
  'hubspot',
  'notion',
  'figma',
  'canva',
  'shopify',
  'postgres',
  'sentry',
]);

/** ¿Este proveedor tiene un logo de marca? (si no, el llamante pinta su icono/gradiente genérico). */
export function hasProviderLogo(provider: string | undefined): boolean {
  return !!provider && WITH_LOGO.has(provider);
}

function SlackLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 122.8 122.8" role="img" aria-label="Slack" xmlns="http://www.w3.org/2000/svg">
      <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zM32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A" />
      <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zM45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0" />
      <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zM90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D" />
      <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zM77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E" />
    </svg>
  );
}

function JiraLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Jira" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="#2684FF"
        d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.762a1.005 1.005 0 0 0-1.005-1.005zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.005 1.005 0 0 0 23.013 0z"
      />
    </svg>
  );
}

function GithubLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="GitHub" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function SheetsLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Google Sheets" xmlns="http://www.w3.org/2000/svg">
      <path fill="#0F9D58" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
      <path fill="#0C7C46" d="M14 2l6 6h-6z" />
      <rect x="7.5" y="11" width="9" height="7.5" rx="0.6" fill="#fff" />
      <path stroke="#0F9D58" strokeWidth="0.9" d="M7.5 13.5h9M7.5 16h9M10.5 11v7.5M13.5 11v7.5" />
    </svg>
  );
}

function GmailLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Gmail" xmlns="http://www.w3.org/2000/svg">
      <path fill="#4caf50" d="M45,16.2l-5,2.75l-5,4.75L35,40h7c1.657,0,3-1.343,3-3V16.2z" />
      <path fill="#1e88e5" d="M3,16.2l3.614,1.71L13,23.7V40H6c-1.657,0-3-1.343-3-3V16.2z" />
      <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
      <path fill="#c62828" d="M3,12.298V16.2l10,7.5V11.2L9.876,8.859C9.132,8.301,8.228,8,7.298,8h0C4.924,8,3,9.924,3,12.298z" />
      <path fill="#fbc02d" d="M45,12.298V16.2l-10,7.5V11.2l3.124-2.341C38.868,8.301,39.772,8,40.702,8h0C43.076,8,45,9.924,45,12.298z" />
    </svg>
  );
}

function CalendarLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Google Calendar" xmlns="http://www.w3.org/2000/svg">
      <rect x="4.5" y="5" width="15" height="15" rx="2.5" fill="#fff" stroke="#4285F4" strokeWidth="1.4" />
      <text x="12" y="16.4" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontSize="8.5" fontWeight="700" fill="#4285F4">
        31
      </text>
    </svg>
  );
}

function GoogleDriveLogo({ size }: { size: number }) {
  // Marca real de Google Drive (simple-icons, monocromo en azul Google).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Google Drive" xmlns="http://www.w3.org/2000/svg" fill="#4285F4">
      <path d={siGoogledrive.path} />
    </svg>
  );
}

function SentryLogo({ size }: { size: number }) {
  // Marca real de Sentry (simple-icons, monocromo en su morado de marca).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Sentry" xmlns="http://www.w3.org/2000/svg" fill="#362D59">
      <path d={siSentry.path} />
    </svg>
  );
}

function SalesforceLogo({ size }: { size: number }) {
  // Nube en el azul de Salesforce (simple-icons ya no incluye su marca): compuesta de círculos + base.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Salesforce" xmlns="http://www.w3.org/2000/svg">
      <g fill="#00A1E0">
        <circle cx="8.5" cy="12.5" r="4" />
        <circle cx="13" cy="10" r="5" />
        <circle cx="17" cy="13" r="3.6" />
        <rect x="6" y="12.5" width="12" height="5" rx="2.5" />
      </g>
    </svg>
  );
}

function StripeLogo({ size }: { size: number }) {
  // Tile en el morado de marca de Stripe (#635BFF) con la "S" en blanco.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Stripe" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="5" fill="#635BFF" />
      <text x="12" y="17" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontSize="14" fontWeight="700" fill="#fff">
        S
      </text>
    </svg>
  );
}

function HubspotLogo({ size }: { size: number }) {
  // Tile en el naranja de marca de HubSpot (#FF7A59) con la "H" en blanco.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="HubSpot" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="5" fill="#FF7A59" />
      <text x="12" y="17" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontSize="13.5" fontWeight="700" fill="#fff">
        H
      </text>
    </svg>
  );
}

function NotionLogo({ size }: { size: number }) {
  // Tile negro con el monograma "N" en blanco (marca de Notion).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Notion" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="5" fill="#000000" />
      <text x="12" y="17" textAnchor="middle" fontFamily="Georgia, 'Times New Roman', serif" fontSize="14" fontWeight="700" fill="#fff">
        N
      </text>
    </svg>
  );
}

function FigmaLogo({ size }: { size: number }) {
  // Los 5 nodos de color de la marca de Figma (glyph simple y fiable).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Figma" xmlns="http://www.w3.org/2000/svg">
      <circle cx="9.5" cy="5.5" r="3.5" fill="#F24E1E" />
      <circle cx="14.5" cy="5.5" r="3.5" fill="#FF7262" />
      <circle cx="9.5" cy="12" r="3.5" fill="#A259FF" />
      <circle cx="14.5" cy="12" r="3.5" fill="#1ABCFE" />
      <circle cx="9.5" cy="18.5" r="3.5" fill="#0ACF83" />
    </svg>
  );
}

function CanvaLogo({ size }: { size: number }) {
  // Círculo con gradiente de marca de Canva (#6420FF→#00C4CC) y la "C" en blanco.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Canva" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="canvaGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6420FF" />
          <stop offset="100%" stopColor="#00C4CC" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="12" fill="url(#canvaGrad)" />
      <text x="12" y="17" textAnchor="middle" fontFamily="Georgia, 'Times New Roman', serif" fontSize="14" fontWeight="700" fill="#fff">
        C
      </text>
    </svg>
  );
}

function ShopifyLogo({ size }: { size: number }) {
  // Tile en el verde de marca de Shopify (#95BF47) con la "S" en blanco.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Shopify" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="5" fill="#95BF47" />
      <text x="12" y="17" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontSize="14" fontWeight="700" fill="#fff">
        S
      </text>
    </svg>
  );
}

function PostgresLogo({ size }: { size: number }) {
  // Tile en el azul de marca de PostgreSQL (#336791) con el monograma "Pg" en blanco.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="PostgreSQL" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="5" fill="#336791" />
      <text x="12" y="16.5" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontSize="10" fontWeight="700" fill="#fff">
        Pg
      </text>
    </svg>
  );
}

/** Logo de marca del proveedor. `null` si no hay: el llamante usa su fallback (icono/gradiente genérico). */
export function ProviderLogo({ provider, size = 18 }: { provider: string | undefined; size?: number }) {
  switch (provider) {
    case 'slack':
      return <SlackLogo size={size} />;
    case 'jira':
      return <JiraLogo size={size} />;
    case 'github':
      return <GithubLogo size={size} />;
    case 'google-sheets':
      return <SheetsLogo size={size} />;
    case 'gmail':
      return <GmailLogo size={size} />;
    case 'google-calendar':
      return <CalendarLogo size={size} />;
    case 'google-drive':
      return <GoogleDriveLogo size={size} />;
    case 'salesforce':
      return <SalesforceLogo size={size} />;
    case 'stripe':
      return <StripeLogo size={size} />;
    case 'hubspot':
      return <HubspotLogo size={size} />;
    case 'notion':
      return <NotionLogo size={size} />;
    case 'figma':
      return <FigmaLogo size={size} />;
    case 'canva':
      return <CanvaLogo size={size} />;
    case 'shopify':
      return <ShopifyLogo size={size} />;
    case 'postgres':
      return <PostgresLogo size={size} />;
    case 'sentry':
      return <SentryLogo size={size} />;
    default:
      return null;
  }
}
