/**
 * MCP Server
 *
 * Define las herramientas disponibles para Claude Code:
 * - inspect_html: Abre el visualizador para un archivo HTML
 * - get_selected_element: Obtiene el elemento seleccionado
 * - highlight_element: Resalta un elemento en el visualizador
 * - apply_css_change: Aplica un cambio de CSS al archivo
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  sendFileContent,
  activateFile,
  clearActiveFile,
  getSelectedElement,
  waitForSelection,
  highlightElement as wsHighlight,
  hasConnectedClients,
  notifyCssApplied
} from './websocket.js';
import { watchFile, unwatchFile } from './file-watcher.js';
import { applyCssChange as applyChange } from './css-editor.js';
import { readAuthorizedFile } from './file-security.js';

// Estado del archivo actualmente inspeccionado
let currentFilePath: string | null = null;
export interface McpServerOptions {
  openBrowser?: boolean;
}

/**
 * Inicia el servidor MCP. Recibe el puerto HTTP real para abrir el navegador.
 */
export async function startMcpServer(httpPort: number, options: McpServerOptions = {}): Promise<void> {
  const server = new McpServer({
    name: 'visual-inspector',
    version: '1.0.0'
  });

  // Tool: inspect_html
  server.tool(
    'inspect_html',
    'Abre el visualizador web para inspeccionar un archivo HTML. El navegador se abre automáticamente.',
    {
      file_path: z.string().describe('Ruta al archivo HTML a inspeccionar'),
      watch: z.boolean().optional().describe('Activar hot reload en cambios (default: true)')
    },
    async ({ file_path, watch = true }) => {
      const absolutePath = path.resolve(file_path);

      const rootPath = path.dirname(absolutePath);
      const activated = activateFile(absolutePath, rootPath);
      if (!activated.success) {
        return { content: [{ type: 'text' as const, text: `Error: ${activated.message}` }] };
      }

      if (currentFilePath && currentFilePath !== absolutePath) unwatchFile(currentFilePath);
      currentFilePath = absolutePath;

      // Activar watch si está habilitado
      if (watch) {
        watchFile(absolutePath);
      } else {
        unwatchFile(absolutePath);
      }

      // Enviar contenido a la web app (si hay clientes conectados)
      sendFileContent(absolutePath);

      const url = `http://127.0.0.1:${httpPort}`;
      if (options.openBrowser !== false) {
        // Abrir Chrome en modo app (ventana limpia sin barra de navegación).
        spawn('open', ['-na', 'Google Chrome', '--args', `--app=${url}`], {
          detached: true,
          stdio: 'ignore'
        }).unref();
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Visualizador abierto para: ${path.basename(absolutePath)}\nURL: ${url}\nHot reload: ${watch ? 'activado' : 'desactivado'}\n\nHaz click en cualquier elemento para seleccionarlo.`
        }]
      };
    }
  );

  // Tool: get_selected_element
  server.tool(
    'get_selected_element',
    'Obtiene información del elemento actualmente seleccionado en el visualizador.',
    {
      wait: z.boolean().optional().describe('Esperar a que el usuario seleccione un elemento (default: false)'),
      timeout: z.number().int().min(1).max(30000).optional().describe('Timeout en ms si wait=true (default: 30000)')
    },
    async ({ wait = false, timeout = 30000 }) => {
      if (!hasConnectedClients()) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: No hay visualizador conectado. Usa inspect_html primero.'
          }]
        };
      }

      let element = getSelectedElement();

      if (!element && wait) {
        try {
          element = await waitForSelection(timeout);
        } catch (error) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Timeout: No se seleccionó ningún elemento.'
            }]
          };
        }
      }

      if (!element) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No hay elemento seleccionado. Haz click en un elemento en el visualizador.'
          }]
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            selector: element.selector,
            tag: element.tag,
            line: element.line,
            styles: element.styles
          }, null, 2)
        }]
      };
    }
  );

  // Tool: highlight_element
  server.tool(
    'highlight_element',
    'Resalta un elemento específico en el visualizador usando su selector CSS.',
    {
      selector: z.string().describe('Selector CSS del elemento a resaltar')
    },
    async ({ selector }) => {
      if (!hasConnectedClients()) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: No hay visualizador conectado. Usa inspect_html primero.'
          }]
        };
      }

      wsHighlight(selector);

      return {
        content: [{
          type: 'text' as const,
          text: `Elemento resaltado: ${selector}`
        }]
      };
    }
  );

  // Tool: apply_css_change
  server.tool(
    'apply_css_change',
    'Aplica un cambio de CSS a un elemento. Modifica el archivo HTML o CSS correspondiente.',
    {
      selector: z.string().describe('Selector CSS del elemento'),
      property: z.string().describe('Propiedad CSS (ej: color, font-size)'),
      value: z.string().describe('Nuevo valor de la propiedad')
    },
    async ({ selector, property, value }) => {
      if (!currentFilePath) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: No hay archivo abierto. Usa inspect_html primero.'
          }]
        };
      }

      let active;
      try {
        active = readAuthorizedFile(currentFilePath, path.dirname(currentFilePath));
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'archivo no autorizado'}` }] };
      }
      const result = applyChange(currentFilePath, { selector, property, value }, {
        rootPath: active.rootPath,
        expectedHash: active.hash,
      });

      if (result.success) {
        // Leer el archivo actualizado y enviarlo a la web app
        sendFileContent(currentFilePath);
        // Notificar el cambio aplicado (flash visual)
        notifyCssApplied(selector, property, value);
      }

      return {
        content: [{
          type: 'text' as const,
          text: result.success
            ? `${result.message}\n${selector} { ${property}: ${value}; }`
            : `Error: ${result.message}`
        }]
      };
    }
  );

  // Tool: close_inspector
  server.tool(
    'close_inspector',
    'Cierra el visualizador y detiene el watch del archivo.',
    {},
    async () => {
      if (currentFilePath) {
        unwatchFile(currentFilePath);
        currentFilePath = null;
      }
      clearActiveFile();

      return {
        content: [{
          type: 'text' as const,
          text: 'Visualizador cerrado. Cierra la pestaña del navegador manualmente.'
        }]
      };
    }
  );

  // Conectar via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
