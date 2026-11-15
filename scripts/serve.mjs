// Servidor local só para testar o app: node scripts/serve.mjs  ->  http://localhost:8099
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const T = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
createServer(async (q, s) => {
  const p = decodeURIComponent(new URL(q.url, 'http://x').pathname).replace(/\/$/, '/index.html');
  try { const b = await readFile(join(DOCS, p)); s.writeHead(200, { 'Content-Type': T[extname(p)] || 'application/octet-stream' }); s.end(b); }
  catch { s.writeHead(404); s.end('404'); }
}).listen(8099, () => console.log('http://localhost:8099'));
