/** Edición CSS confinada al archivo activo autorizado por MCP. */

import path from 'node:path';
import * as csstree from 'css-tree';
import {
  atomicWriteAuthorizedFile,
  assertAuthorizedPath,
  readAuthorizedFile,
} from './file-security.js';

export interface CssChange {
  selector: string;
  property: string;
  value: string;
}

export interface CssEditOptions {
  rootPath: string;
  expectedHash: string;
}

export interface ApplyResult {
  success: boolean;
  message: string;
  modifiedFile?: string;
  hash?: string;
}

const MAX_SELECTOR = 1024;
const MAX_PROPERTY = 128;
const MAX_VALUE = 4096;

function failure(message: string): ApplyResult {
  return { success: false, message };
}

function validateChange(change: CssChange): string | null {
  if (!change || typeof change.selector !== 'string' || change.selector.length === 0 || change.selector.length > MAX_SELECTOR) {
    return 'Selector CSS inválido';
  }
  if (!change.property || change.property.length > MAX_PROPERTY || !/^-{0,2}[a-zA-Z][a-zA-Z0-9_-]*$/.test(change.property)) {
    return 'Propiedad CSS inválida';
  }
  if (typeof change.value !== 'string' || change.value.length === 0 || change.value.length > MAX_VALUE) {
    return 'Valor CSS inválido';
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(change.selector + change.property + change.value)) {
    return 'CSS con caracteres de control';
  }
  if (/<\/?(?:style|script|html)\b|@import\b|url\s*\(/i.test(change.selector + change.value)) {
    return 'CSS con HTML, script, import o URL no permitido';
  }
  try {
    csstree.parse(change.selector, { context: 'selectorList' });
    csstree.parse(change.value, { context: 'value' });
  } catch {
    return 'Selector o valor CSS no válido';
  }
  return null;
}

function containsUnsafeCss(css: string): boolean {
  return /@import\b|url\s*\(/i.test(css);
}

/** Aplica un cambio únicamente con un contexto de archivo autorizado. */
export function applyCssChange(htmlPath: string, change: CssChange, options?: CssEditOptions): ApplyResult {
  if (!options) return failure('Falta el contexto de archivo autorizado por MCP');
  const validationError = validateChange(change);
  if (validationError) return failure(validationError);

  let htmlSnapshot;
  try {
    htmlSnapshot = readAuthorizedFile(htmlPath, options.rootPath);
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'No se pudo leer el HTML autorizado');
  }
  if (htmlSnapshot.hash !== options.expectedHash) return failure('El HTML activo cambió; vuelve a inspeccionarlo');
  if (containsUnsafeCss(htmlSnapshot.content)) return failure('El HTML contiene CSS externo o activo no permitido');

  const inlineResult = applyToInlineStyle(htmlSnapshot.content, change);
  if (inlineResult.found) {
    return writeResult(htmlSnapshot.filePath, htmlSnapshot.rootPath, inlineResult.content, htmlSnapshot.hash, 'CSS aplicado en <style>');
  }

  let linkedCss: string[];
  try {
    linkedCss = findLinkedCssFiles(htmlSnapshot.content, path.dirname(htmlSnapshot.filePath), options.rootPath);
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'No se pudieron validar los CSS enlazados');
  }
  for (const cssFile of linkedCss) {
    let cssSnapshot;
    try { cssSnapshot = readAuthorizedFile(cssFile, options.rootPath); } catch { continue; }
    if (containsUnsafeCss(cssSnapshot.content)) return failure('El CSS enlazado contiene import o URL no permitido');
    const cssResult = modifyCssContent(cssSnapshot.content, change);
    if (cssResult.modified) {
      try {
        const latestHtml = readAuthorizedFile(htmlSnapshot.filePath, options.rootPath);
        if (latestHtml.hash !== options.expectedHash) return failure('El HTML activo cambió; vuelve a inspeccionarlo');
      } catch (error) {
        return failure(error instanceof Error ? error.message : 'No se pudo verificar el HTML activo');
      }
      return writeResult(cssSnapshot.filePath, cssSnapshot.rootPath, cssResult.content, cssSnapshot.hash, `CSS aplicado en ${path.basename(cssFile)}`);
    }
  }

  const newContent = addStyleBlock(htmlSnapshot.content, change);
  return writeResult(htmlSnapshot.filePath, htmlSnapshot.rootPath, newContent, htmlSnapshot.hash, 'Nuevo estilo añadido');
}

function writeResult(filePath: string, rootPath: string, content: string, expectedHash: string, message: string): ApplyResult {
  try {
    const snapshot = atomicWriteAuthorizedFile(filePath, rootPath, content, expectedHash);
    return { success: true, message: `${message} en ${path.basename(filePath)}`, modifiedFile: filePath, hash: snapshot.hash };
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'No se pudo escribir el archivo');
  }
}

function applyToInlineStyle(html: string, change: CssChange): { found: boolean; content: string } {
  const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let found = false;
  const newHtml = html.replace(styleRegex, (match, cssContent: string) => {
    if (containsUnsafeCss(cssContent)) return match;
    const result = modifyCssContent(cssContent, change);
    if (!result.modified) return match;
    found = true;
    return match.replace(cssContent, result.content);
  });
  return { found, content: newHtml };
}

function modifyCssContent(css: string, change: CssChange): { modified: boolean; content: string } {
  try {
    const ast = csstree.parse(css);
    let modified = false;
    csstree.walk(ast, {
      visit: 'Rule',
      enter(node) {
        if (normalizeSelector(csstree.generate(node.prelude)) !== normalizeSelector(change.selector)) return;
        if (node.block.type !== 'Block') return;
        let propertyFound = false;
        csstree.walk(node.block, {
          visit: 'Declaration',
          enter(decl) {
            if (decl.property !== change.property) return;
            decl.value = csstree.parse(change.value, { context: 'value' }) as csstree.Value;
            propertyFound = true;
            modified = true;
          },
        });
        if (!propertyFound) {
          node.block.children.appendData({
            type: 'Declaration',
            important: false,
            property: change.property,
            value: csstree.parse(change.value, { context: 'value' }) as csstree.Value,
          });
          modified = true;
        }
      },
    });
    return { modified, content: modified ? csstree.generate(ast) : css };
  } catch {
    return { modified: false, content: css };
  }
}

export function findLinkedCssFiles(html: string, baseDir: string, rootPath: string): string[] {
  const files: string[] = [];
  const linkRegex = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkRegex)) {
    const tag = match[0];
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || !rel.split(/\s+/).some((item) => item.toLowerCase() === 'stylesheet')) continue;
    if (/^(?:[a-z]+:|\/\/|#)/i.test(href) || href.includes('?') || href.includes('#')) continue;
    let decodedHref: string;
    try { decodedHref = decodeURIComponent(href); } catch { continue; }
    const resolved = path.resolve(baseDir, decodedHref);
    if (path.extname(resolved).toLowerCase() !== '.css') continue;
    try {
      assertAuthorizedPath(resolved, rootPath);
      files.push(resolved);
    } catch {
      // Un enlace no autorizado nunca se convierte en una ruta de escritura.
    }
  }
  return [...new Set(files)];
}

function addStyleBlock(html: string, change: CssChange): string {
  const newStyle = `\n<style>\n${change.selector} {\n  ${change.property}: ${change.value};\n}\n</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${newStyle}\n</head>`) : `${newStyle}\n${html}`;
}

function normalizeSelector(selector: string): string {
  return selector.trim().replace(/\s+/g, ' ').replace(/\s*>\s*/g, ' > ').replace(/\s*,\s*/g, ', ');
}

export function getStylesForSelector(htmlPath: string, selector: string): Record<string, string> {
  const styles: Record<string, string> = {};
  let snapshot;
  try { snapshot = readAuthorizedFile(htmlPath, path.dirname(path.resolve(htmlPath))); } catch { return styles; }
  const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (const match of snapshot.content.matchAll(styleRegex)) Object.assign(styles, extractStylesFromCss(match[1], selector));
  for (const cssFile of findLinkedCssFiles(snapshot.content, path.dirname(snapshot.filePath), snapshot.rootPath)) {
    try { Object.assign(styles, extractStylesFromCss(readAuthorizedFile(cssFile, snapshot.rootPath).content, selector)); } catch { /* no-op */ }
  }
  return styles;
}

function extractStylesFromCss(css: string, targetSelector: string): Record<string, string> {
  const styles: Record<string, string> = {};
  try {
    const ast = csstree.parse(css);
    csstree.walk(ast, {
      visit: 'Rule',
      enter(node) {
        if (normalizeSelector(csstree.generate(node.prelude)) !== normalizeSelector(targetSelector) || node.block.type !== 'Block') return;
        csstree.walk(node.block, {
          visit: 'Declaration',
          enter(decl) { styles[decl.property] = csstree.generate(decl.value); },
        });
      },
    });
  } catch { /* CSS incompleto: no exponer datos parciales */ }
  return styles;
}
