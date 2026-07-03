// Servidor estático mínimo (sin dependencias) para la SPA en producción. Sirve apps/web/dist y hace
// fallback a index.html en rutas de cliente (React Router). Escucha en PORT (Railway) o 8080.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('./dist/', import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

async function sendFile(res, file, status = 200) {
  const data = await readFile(file);
  const isHtml = extname(file) === '.html';
  res.writeHead(status, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    // Los assets con hash son inmutables; el HTML nunca se cachea (para recoger builds nuevos).
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(data);
}

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    // Normaliza y neutraliza cualquier intento de path traversal.
    const rel = normalize(urlPath).replace(/^([/\\]|\.\.[/\\])+/, '');
    let file = join(DIST, rel);
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
      await sendFile(res, file);
    } catch {
      // Ruta de cliente (SPA): devolvemos index.html.
      await sendFile(res, join(DIST, 'index.html'));
    }
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal Server Error');
  }
}).listen(PORT, '0.0.0.0', () => console.log(`web sirviendo apps/web/dist en el puerto ${PORT}`));
