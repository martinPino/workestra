// Servidor del Container «runtime». Expone por HTTP los tres ejecutores que no caben en un isolate de
// Workers: `code` (sandbox de JS), `browser` (Playwright) y `extract` (OCR/PDF).
//
// El Worker le habla por su binding de Container; esto NO se publica en internet, así que no lleva
// autenticación propia: la frontera de confianza es el binding, igual que con un Durable Object. Si
// algún día se expusiera por una URL pública, esto necesitaría auth ANTES de nada.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);

/** Lee el cuerpo completo. Las peticiones las hace el Worker, así que no hay cuerpos hostiles. */
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Ejecuta un nodo. Los ejecutores se cargan PEREZOSAMENTE: arrancar Chromium o los traineddata de
 * tesseract en cada arranque del contenedor retrasaría también a quien solo pide `code`.
 */
async function runNode(type, payload) {
  const plugins = await import('@core/sdk-plugins');
  switch (type) {
    case 'code': {
      const { CodeNodeExecutor } = plugins;
      return new CodeNodeExecutor().execute(payload.ctx);
    }
    case 'extract': {
      const { ExtractNodeExecutor } = plugins;
      return new ExtractNodeExecutor(payload.deps).execute(payload.ctx);
    }
    case 'browser': {
      const { createBrowserEngine } = plugins;
      const engine = createBrowserEngine(payload.engine ?? 'playwright');
      return engine.run(payload.ctx);
    }
    default:
      throw new Error(`Tipo de nodo no soportado en el container: ${type}`);
  }
}

createServer(async (req, res) => {
  if (req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/run') return send(res, 404, { error: 'No encontrado.' });

  try {
    const { type, payload } = await readJson(req);
    return send(res, 200, { ok: true, result: await runNode(type, payload ?? {}) });
  } catch (e) {
    // Un fallo del nodo NO tumba el contenedor: se devuelve como resultado para que el Worker lo
    // convierta en un `node.failed` del stream, igual que cualquier otro error de ejecución.
    return send(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`[runtime] escuchando en ${PORT}`));
