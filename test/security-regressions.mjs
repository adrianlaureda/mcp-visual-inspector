import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "visual-inspector-security-"));
const htmlPath = path.join(tmp, "index.html");
const cssPath = path.join(tmp, "style.css");
fs.writeFileSync(cssPath, ".card { color: black; }", "utf8");
fs.writeFileSync(
  htmlPath,
  '<!doctype html><html><head><link rel="stylesheet" href="style.css"><style>.card { color: black; }</style></head><body><div class="card">ok</div></body></html>',
  "utf8",
);

const { applyCssChange } = await import(path.join(root, "dist/css-editor.js"));
const { readAuthorizedFile } = await import(path.join(root, "dist/file-security.js"));
const { startHttpServer, closeHttpServer, getHttpServer } = await import(path.join(root, "dist/http-server.js"));
const {
  startWebSocketServer,
  configureWebSocketAuth,
  closeWebSocketServer,
  activateFile,
  clearActiveFile,
  sendFileContent,
} = await import(path.join(root, "dist/websocket.js"));

const webSource = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
assert.match(webSource, /sandbox="allow-scripts"/, "el preview debe usar sandbox sin same-origin");
assert.match(webSource, /source !== previewIframe\.contentWindow/, "el puente debe validar el source del iframe");
assert.match(webSource, /nonce/, "el puente debe usar nonce local");
assert.doesNotMatch(webSource, /unpkg\.com\/lucide|lucide\.createIcons/, "no debe depender de CDN externo");

const outsideHtml = path.join(os.tmpdir(), `visual-inspector-outside-${process.pid}.html`);
fs.writeFileSync(outsideHtml, "<p>outside</p>", "utf8");
const symlinkPath = path.join(tmp, "symlink.html");
fs.symlinkSync(outsideHtml, symlinkPath);
assert.throws(() => readAuthorizedFile(symlinkPath, tmp), /regular|simbólico/i, "no se deben aceptar symlinks");
const hardlinkPath = path.join(tmp, "hardlink.html");
fs.linkSync(htmlPath, hardlinkPath);
assert.throws(() => readAuthorizedFile(hardlinkPath, tmp), /hardlink/i, "no se deben aceptar hardlinks");
fs.unlinkSync(hardlinkPath);
fs.unlinkSync(outsideHtml);

assert.throws(
  () => readAuthorizedFile(htmlPath, tmp, 32),
  /bytes|tamaño|límite/i,
  "el límite de tamaño debe ser obligatorio",
);

assert.equal(
  applyCssChange(htmlPath, { selector: ".card", property: "color", value: "red" }).success,
  false,
  "la API de edición debe exigir un contexto autorizado",
);

const active = activateFile(htmlPath, tmp);
assert.equal(active.success, true, "MCP debe poder autorizar el archivo activo");
assert.equal(
  applyCssChange(htmlPath, { selector: ".card", property: "color", value: "red" }, {
    rootPath: tmp,
    expectedHash: active.hash,
  }).success,
  true,
);

const before = fs.readFileSync(htmlPath, "utf8");
const unsafe = applyCssChange(htmlPath, {
  selector: ".card",
  property: "color",
  value: "red; }</style><script>alert(1)</script>",
}, { rootPath: tmp, expectedHash: readAuthorizedFile(htmlPath, tmp).hash });
assert.equal(unsafe.success, false, "no se debe interpolar CSS/HTML activo");
assert.equal(fs.readFileSync(htmlPath, "utf8"), before, "un CSS inválido no debe escribir");

const outsideRootCss = path.join(path.dirname(tmp), `visual-inspector-outside-${process.pid}.css`);
fs.writeFileSync(outsideRootCss, ".card { color: green; }", "utf8");
fs.writeFileSync(htmlPath, `<link rel="stylesheet" href="../${path.basename(outsideRootCss)}">`, "utf8");
const escapeResult = applyCssChange(htmlPath, { selector: ".card", property: "color", value: "red" }, {
  rootPath: tmp,
  expectedHash: readAuthorizedFile(htmlPath, tmp).hash,
});
assert.equal(escapeResult.success, true, "el fallback seguro puede añadir estilo al HTML autorizado");
assert.equal(fs.readFileSync(outsideRootCss, "utf8"), ".card { color: green; }", "no se puede escribir mediante traversal fuera de la raíz");

const stalePath = path.join(tmp, "stale.html");
fs.writeFileSync(stalePath, "<html><head><style>.card { color: black; }</style></head><body><div class=\"card\">ok</div></body></html>", "utf8");
const staleActive = activateFile(stalePath, tmp);
assert.equal(staleActive.success, true, "el archivo de hash obsoleto debe poder activarse inicialmente");
fs.appendFileSync(stalePath, "<!-- cambio externo -->", "utf8");
const staleBefore = fs.readFileSync(stalePath, "utf8");
const staleResult = applyCssChange(stalePath, { selector: ".card", property: "color", value: "red" }, {
  rootPath: tmp,
  expectedHash: staleActive.hash,
});
assert.equal(staleResult.success, false, "un hash obsoleto debe rechazar la edición");
assert.equal(fs.readFileSync(stalePath, "utf8"), staleBefore, "un hash obsoleto no debe escribir");

const wsPort = await startWebSocketServer();
const httpPort = await startHttpServer(wsPort);
configureWebSocketAuth(httpPort);
const httpServer = getHttpServer();
assert.equal(httpServer.address().address, "127.0.0.1", "HTTP debe escuchar solo en loopback");

const request = (headers) => new Promise((resolve, reject) => {
  const req = http.get({ host: "127.0.0.1", port: httpPort, path: "/", headers }, (res) => {
    res.resume();
    res.on("end", () => resolve(res));
  });
  req.on("error", reject);
});
const page = await request({ Host: `127.0.0.1:${httpPort}` });
assert.equal(page.headers["access-control-allow-origin"], undefined, "no se debe publicar CORS global");
const wrongHost = await request({ Host: `localhost:${httpPort}` });
assert.equal(wrongHost.statusCode, 421, "HTTP debe rechazar Host ajeno");

const origin = `http://127.0.0.1:${httpPort}`;
const openClient = (clientOrigin, clientHost) => new Promise((resolve) => {
  const headers = {};
  if (clientOrigin !== undefined) headers.Origin = clientOrigin;
  if (clientHost !== undefined) headers.Host = clientHost;
  const client = new WebSocket(`ws://127.0.0.1:${wsPort}`, { headers });
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ client, ...result });
  };
  const timer = setTimeout(() => { try { client.close(); } catch {} finish({ open: false }); }, 2000);
  client.once("open", () => finish({ open: true }));
  client.once("unexpected-response", () => finish({ open: false }));
  client.once("error", () => { if (!settled) finish({ open: false }); });
});
const waitClosed = (client) => new Promise((resolve, reject) => {
  if (client.readyState === WebSocket.CLOSED) return resolve({ code: 1000 });
  const timer = setTimeout(() => reject(new Error("timeout esperando cierre WS")), 2000);
  client.once("close", (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
});
const waitMessage = (client) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout esperando mensaje WS")), 2000);
  client.once("message", (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString("utf8"))); });
});

assert.equal((await openClient(undefined)).open, false, "WS debe rechazar Origin ausente");
assert.equal((await openClient("null")).open, false, "WS debe rechazar Origin null");
assert.equal((await openClient("http://127.0.0.1:1")).open, false, "WS debe rechazar Origin ajeno");
assert.equal((await openClient(origin, `localhost:${wsPort}`)).open, false, "WS debe rechazar Host ajeno");

const mcpPath = path.join(tmp, "mcp-equivalent.html");
fs.writeFileSync(mcpPath, "<html><head><style>.card { color: black; }</style></head><body><div class=\"card\">ok</div></body></html>", "utf8");
const mcpActive = activateFile(mcpPath, tmp);
const mcpEdit = applyCssChange(mcpPath, { selector: ".card", property: "padding", value: "24px" }, {
  rootPath: tmp,
  expectedHash: mcpActive.hash,
});
assert.equal(mcpEdit.success, true, "la edición equivalente a MCP debe pasar");
sendFileContent(mcpPath);
const mcpClient = await openClient(origin);
assert.equal(mcpClient.open, true, "el inspector autorizado debe conectar");
mcpClient.client.send(JSON.stringify({ type: "ready" }));
const mcpMessage = await waitMessage(mcpClient.client);
assert.equal(mcpMessage.type, "load-html", "ready debe recibir el archivo activo");
assert.match(mcpMessage.payload.content, /24px/, "sendFileContent debe releer el contenido actualizado");
mcpClient.client.close();
await waitClosed(mcpClient.client);

const largePath = path.join(tmp, "large.html");
const largeContent = `<html><body><p>${"x".repeat(70 * 1024)}</p></body></html>`;
fs.writeFileSync(largePath, largeContent, "utf8");
const largeActive = activateFile(largePath, tmp);
assert.equal(largeActive.success, true, "MCP debe activar HTML de 70 KiB");
const largeClient = await openClient(origin);
assert.equal(largeClient.open, true, "cliente autorizado para HTML grande debe conectar");
largeClient.client.send(JSON.stringify({ type: "ready" }));
const largeMessage = await waitMessage(largeClient.client);
assert.equal(largeMessage.payload.content.length, largeContent.length, "outbound debe cubrir un HTML activo de 70 KiB");
const beforeInboundRoute = fs.readFileSync(largePath, "utf8");
largeClient.client.send(JSON.stringify({ type: "load-html", payload: { filePath: "/tmp/attacker.html", content: "<script>bad()</script>" } }));
const routeClose = await waitClosed(largeClient.client);
assert.equal(routeClose.code, 1008, "load-html entrante debe rechazarse");
assert.equal(fs.readFileSync(largePath, "utf8"), beforeInboundRoute, "load-html entrante no debe escribir");

const payloadClient = await openClient(origin);
assert.equal(payloadClient.open, true, "cliente válido para límite inbound debe conectar");
payloadClient.client.send(JSON.stringify({ type: "ping", payload: "x".repeat(64 * 1024) }));
const payloadClose = await waitClosed(payloadClient.client);
assert.equal(payloadClose.code, 1009, "payload inbound superior a 64 KiB debe rechazarse");

clearActiveFile();
closeWebSocketServer();
closeHttpServer();
fs.unlinkSync(outsideRootCss);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("security regressions: ok");
