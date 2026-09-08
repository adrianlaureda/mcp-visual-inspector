/** Servidor HTTP local del inspector. */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOOPBACK_HOST = '127.0.0.1';
const MAX_WEB_BYTES = 1024 * 1024;
let server: http.Server | null = null;
let injectedWsPort = 0;
let expectedHost: string | null = null;

export function startHttpServer(wsPort: number): Promise<number> {
  if (!Number.isInteger(wsPort) || wsPort <= 0 || wsPort > 65535) return Promise.reject(new Error('Puerto WS inválido'));
  injectedWsPort = wsPort;
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (expectedHost === null || req.headers.host !== expectedHost) {
        res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8', 'Connection': 'close' });
        res.end('Host no autorizado');
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Allow': 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url || '/', `http://${expectedHost}`);
      } catch {
        res.writeHead(400, securityHeaders('text/plain; charset=utf-8'));
        res.end('Solicitud inválida');
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') return serveWebApp(res);
      if (url.pathname === '/health') {
        res.writeHead(200, securityHeaders('application/json'));
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404, securityHeaders('text/plain; charset=utf-8'));
      res.end('Not Found');
    });

    server.once('error', reject);
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 5000;
    server.timeout = 5000;
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server?.address();
      if (!address || typeof address === 'string') return reject(new Error('No se pudo obtener el puerto HTTP'));
      expectedHost = `${LOOPBACK_HOST}:${address.port}`;
      resolve(address.port);
    });
  });
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ws://${LOOPBACK_HOST}:${injectedWsPort}; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-src 'self'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

function serveWebApp(res: http.ServerResponse): void {
  // `tsc` no copia `web/`; resolver siempre el recurso fuente evita servir un dist/web obsoleto.
  const webAppPath = path.resolve(__dirname, '../web/index.html');
  fs.readFile(webAppPath, (error, buffer) => {
    if (error) {
      res.writeHead(500, securityHeaders('text/plain; charset=utf-8'));
      res.end('Error cargando web app');
      return;
    }
    if (buffer.byteLength > MAX_WEB_BYTES) {
      res.writeHead(500, securityHeaders('text/plain; charset=utf-8'));
      res.end('Web app demasiado grande');
      return;
    }
    const content = buffer.toString('utf8');
    const wsScript = `<script>window.WS_HOST = ${JSON.stringify(LOOPBACK_HOST)}; window.WS_PORT = ${injectedWsPort};</script>`;
    const modified = content.replace(/<head>/i, `<head>\n  ${wsScript}`);
    res.writeHead(200, securityHeaders('text/html; charset=utf-8'));
    res.end(modified);
  });
}

export function closeHttpServer(): void {
  if (server) server.close();
  server = null;
  expectedHost = null;
}

export function getHttpServer(): http.Server | null { return server; }
