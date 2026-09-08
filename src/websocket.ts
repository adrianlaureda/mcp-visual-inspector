/** Canal local autenticado entre MCP y la aplicación del inspector. */

import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { applyCssChange, type CssChange } from './css-editor.js';
import { readAuthorizedFile, type FileSnapshot, MAX_FILE_BYTES } from './file-security.js';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_WS_PAYLOAD = 64 * 1024;
// El límite de entrada protege el parser; la salida debe permitir el HTML activo de 1 MiB.
// JSON puede multiplicar el tamaño por el escape de caracteres, pero queda acotado.
const MAX_OUTBOUND_PAYLOAD = MAX_FILE_BYTES * 7 + 4096;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_CLIENTS = 4;
const MAX_SELECTOR = 1024;
const MAX_JSON_DEPTH = 6;

let wss: WebSocketServer | null = null;
const connectedClients = new Set<WebSocket>();
const readyClients = new Set<WebSocket>();
let expectedOrigin: string | null = null;
let expectedHost: string | null = null;
let selectedElement: SelectedElement | null = null;
let currentHtml: ActiveFile | null = null;
let selectionResolvers: Array<{ resolve: (element: SelectedElement) => void; reject: (error: Error) => void }> = [];

interface ActiveFile extends FileSnapshot {}

export interface SelectedElement {
  selector: string;
  tag: string;
  line: number;
  styles: Record<string, string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function depth(value: unknown, current = 0): number {
  if (!isPlainObject(value) && !Array.isArray(value)) return current;
  if (current >= MAX_JSON_DEPTH) return current + 1;
  const children = isPlainObject(value) ? Object.values(value) : value;
  return Math.max(current, ...children.map((child) => depth(child, current + 1)));
}

function validSelector(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SELECTOR && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateSelectedElement(payload: unknown): payload is SelectedElement {
  if (!isPlainObject(payload) || !validSelector(payload.selector) || typeof payload.tag !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/i.test(payload.tag)) return false;
  if (typeof payload.line !== 'number' || !Number.isSafeInteger(payload.line) || payload.line < 0 || payload.line > 10_000_000) return false;
  if (!isPlainObject(payload.styles) || Object.keys(payload.styles).length > 32) return false;
  return Object.values(payload.styles).every((value) => typeof value === 'string' && value.length <= 512);
}

function validCssChange(payload: unknown): payload is CssChange {
  return isPlainObject(payload) && validSelector(payload.selector) && typeof payload.property === 'string' && payload.property.length <= 128 && typeof payload.value === 'string' && payload.value.length <= 4096;
}

function safeSend(client: WebSocket, type: string, payload?: unknown): boolean {
  if (client.readyState !== WebSocket.OPEN) return false;
  if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
    client.close(1013, 'backpressure');
    return false;
  }
  let encoded: string;
  try { encoded = JSON.stringify({ type, payload }); } catch { client.close(1008, 'payload inválido'); return false; }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_OUTBOUND_PAYLOAD) {
    client.close(1009, 'mensaje demasiado grande');
    return false;
  }
  client.send(encoded);
  return true;
}

function authorizedRequest(request: IncomingMessage): boolean {
  return expectedOrigin !== null && expectedHost !== null && request.headers.host === expectedHost && request.headers.origin === expectedOrigin;
}

/** Inicia WS solo en loopback y con autenticación exacta de Host/Origin. */
export function startWebSocketServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    wss = new WebSocketServer({
      host: LOOPBACK_HOST,
      port: 0,
      maxPayload: MAX_WS_PAYLOAD,
      clientTracking: true,
      perMessageDeflate: false,
      verifyClient: (info, done) => done(authorizedRequest(info.req), 403, 'Origen o Host no autorizado'),
    });

    wss.on('listening', () => {
      const address = wss?.address();
      if (!address || typeof address === 'string') return reject(new Error('No se pudo obtener el puerto WS'));
      expectedHost = `${LOOPBACK_HOST}:${address.port}`;
      resolve(address.port);
    });
    wss.on('connection', (ws) => {
      if (connectedClients.size >= MAX_CLIENTS) {
        ws.close(1013, 'límite de clientes');
        return;
      }
      connectedClients.add(ws);
      ws.on('message', (data) => handleRawMessage(ws, data));
      ws.on('close', () => {
        connectedClients.delete(ws);
        readyClients.delete(ws);
      });
      ws.on('error', () => {
        connectedClients.delete(ws);
        readyClients.delete(ws);
      });
    });
    wss.on('error', reject);
  });
}

export function configureWebSocketAuth(httpPort: number): void {
  expectedOrigin = `http://${LOOPBACK_HOST}:${httpPort}`;
}

function handleRawMessage(ws: WebSocket, data: RawData): void {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  if (buffer.byteLength > MAX_WS_PAYLOAD) return ws.close(1009, 'mensaje demasiado grande');
  let message: unknown;
  try { message = JSON.parse(buffer.toString('utf8')); } catch { return ws.close(1007, 'JSON inválido'); }
  if (!isPlainObject(message) || typeof message.type !== 'string' || depth(message) > MAX_JSON_DEPTH) return ws.close(1008, 'mensaje inválido');
  handleMessage(message.type, message.payload, ws);
}

function handleMessage(type: string, payload: unknown, ws: WebSocket): void {
  switch (type) {
    case 'element-selected':
      if (!validateSelectedElement(payload)) return ws.close(1008, 'selección inválida');
      selectedElement = payload;
      for (const resolver of selectionResolvers) resolver.resolve(payload);
      selectionResolvers = [];
      return;
    case 'ping':
      if (payload !== undefined) return ws.close(1008, 'ping inválido');
      safeSend(ws, 'pong');
      return;
    case 'ready':
      if (payload !== undefined) return ws.close(1008, 'ready inválido');
      readyClients.add(ws);
      if (currentHtml) safeSend(ws, 'load-html', { filePath: path.basename(currentHtml.filePath), content: currentHtml.content });
      return;
    case 'apply-css':
      // La UI puede proponer solo una edición; nunca una ruta o contenido. El archivo activo lo fija MCP.
      if (!validCssChange(payload) || !currentHtml) return ws.close(1008, 'edición CSS inválida');
      const result = applyCssChange(currentHtml.filePath, payload, { rootPath: currentHtml.rootPath, expectedHash: currentHtml.hash });
      if (result.success) {
        refreshActiveFile();
        notifyCssApplied(payload.selector, payload.property, payload.value);
      }
      return;
    default:
      return ws.close(1008, 'tipo de mensaje no permitido');
  }
}

function refreshActiveFile(): void {
  if (!currentHtml) return;
  try {
    currentHtml = readAuthorizedFile(currentHtml.filePath, currentHtml.rootPath);
    broadcast('load-html', { filePath: path.basename(currentHtml.filePath), content: currentHtml.content });
  } catch {
    clearActiveFile();
  }
}

export function broadcast(type: string, payload?: unknown): void {
  for (const client of readyClients) safeSend(client, type, payload);
}

export function activateFile(filePath: string, rootPath: string): FileSnapshot & { success: true } | { success: false; message: string } {
  try {
    const snapshot = readAuthorizedFile(filePath, rootPath);
    currentHtml = snapshot;
    selectedElement = null;
    return { ...snapshot, success: true };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Archivo no autorizado' };
  }
}

export function clearActiveFile(): void {
  currentHtml = null;
  selectedElement = null;
  for (const resolver of selectionResolvers) resolver.reject(new Error('El inspector se ha cerrado'));
  selectionResolvers = [];
}

export function sendFileContent(filePath: string): void {
  if (!currentHtml || path.resolve(filePath) !== currentHtml.filePath) return;
  try {
    // El contenido canónico siempre se relee del archivo autorizado.
    currentHtml = readAuthorizedFile(currentHtml.filePath, currentHtml.rootPath);
    broadcast('load-html', { filePath: path.basename(currentHtml.filePath), content: currentHtml.content });
  } catch {
    clearActiveFile();
  }
}

export function notifyFileChanged(filePath: string): void {
  if (!currentHtml || path.resolve(filePath) !== currentHtml.filePath) return;
  try {
    currentHtml = readAuthorizedFile(currentHtml.filePath, currentHtml.rootPath);
    broadcast('file-changed', { filePath: path.basename(currentHtml.filePath), content: currentHtml.content });
  } catch {
    clearActiveFile();
  }
}

export function highlightElement(selector: string): void {
  if (validSelector(selector)) broadcast('highlight-element', { selector });
}

export function notifyCssApplied(selector: string, property: string, value: string): void {
  if (validSelector(selector) && typeof property === 'string' && typeof value === 'string') broadcast('css-applied', { selector, property, value });
}

export function getSelectedElement(): SelectedElement | null { return selectedElement; }

export function waitForSelection(timeoutMs = 30_000): Promise<SelectedElement> {
  const boundedTimeout = Math.max(1, Math.min(30_000, timeoutMs));
  return new Promise((resolve, reject) => {
    if (selectedElement) return resolve(selectedElement);
    const entry = { resolve, reject };
    selectionResolvers.push(entry);
    setTimeout(() => {
      const index = selectionResolvers.indexOf(entry);
      if (index !== -1) {
        selectionResolvers.splice(index, 1);
        reject(new Error('Timeout esperando selección de elemento'));
      }
    }, boundedTimeout).unref?.();
  });
}

export function hasConnectedClients(): boolean { return connectedClients.size > 0; }
export function getWebSocketServer(): WebSocketServer | null { return wss; }

export function closeWebSocketServer(): void {
  for (const resolver of selectionResolvers) resolver.reject(new Error('Servidor WS cerrado'));
  selectionResolvers = [];
  for (const client of connectedClients) client.close(1001, 'servidor cerrado');
  connectedClients.clear();
  readyClients.clear();
  currentHtml = null;
  if (wss) wss.close();
  wss = null;
  expectedOrigin = null;
  expectedHost = null;
}
