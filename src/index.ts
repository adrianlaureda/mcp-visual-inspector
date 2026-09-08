#!/usr/bin/env node
/**
 * Visual Inspector MCP - Entry Point
 *
 * Servidor MCP que permite inspeccionar HTML visualmente desde Claude Code.
 * Combina: MCP (stdio) + HTTP (dinámico) + WebSocket (dinámico)
 *
 * Puertos asignados dinámicamente por el OS para evitar conflictos.
 * Shutdown limpio al cerrar stdin (cuando Claude Code desconecta).
 */

import { startMcpServer } from './mcp-server.js';
import { startHttpServer, closeHttpServer } from './http-server.js';
import { startWebSocketServer, configureWebSocketAuth, closeWebSocketServer } from './websocket.js';

async function main() {
  try {
    // 1. Iniciar WS con puerto dinámico (la web app necesita saber este puerto)
    const wsPort = await startWebSocketServer();

    // 2. Iniciar HTTP con puerto dinámico, pasándole el puerto WS para inyectarlo en el HTML
    const httpPort = await startHttpServer(wsPort);
    configureWebSocketAuth(httpPort);

    // 3. Graceful shutdown: cuando Claude Code cierra la conexión, stdin se cierra.
    //    Detectamos esto para apagar servidores y que el proceso termine limpiamente.
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);

    // 4. Iniciar servidor MCP (stdio) - este bloquea mientras la conexión esté activa
    await startMcpServer(httpPort);

  } catch (error) {
    console.error('Error iniciando Visual Inspector MCP:', error);
    process.exit(1);
  }
}

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  closeWebSocketServer();
  closeHttpServer();
  process.exit(0);
}

main();
