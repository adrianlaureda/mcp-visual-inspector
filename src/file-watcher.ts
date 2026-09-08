/** Watch acotado al archivo HTML activo y sus CSS locales autorizados. */

import chokidar, { FSWatcher } from 'chokidar';
import path from 'node:path';
import { findLinkedCssFiles } from './css-editor.js';
import { readAuthorizedFile } from './file-security.js';
import { notifyFileChanged } from './websocket.js';

const watchers = new Map<string, FSWatcher>();
const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 100;

export function watchFile(filePath: string): void {
  const absolutePath = path.resolve(filePath);
  if (watchers.has(absolutePath)) return;
  const rootPath = path.dirname(absolutePath);
  let snapshot;
  try { snapshot = readAuthorizedFile(absolutePath, rootPath); } catch { return; }
  const linkedCss = findLinkedCssFiles(snapshot.content, rootPath, rootPath);
  const patterns = [absolutePath, ...linkedCss];
  const watcher = chokidar.watch(patterns, {
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  watcher.on('change', (changedPath) => handleFileChange(changedPath, absolutePath));
  watcher.on('error', (error) => console.error(`Error watching ${absolutePath}:`, error));
  watchers.set(absolutePath, watcher);
}

function handleFileChange(changedPath: string, mainHtmlPath: string): void {
  const existing = debounceTimers.get(changedPath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(changedPath);
    try {
      readAuthorizedFile(changedPath, path.dirname(mainHtmlPath));
      notifyFileChanged(mainHtmlPath);
    } catch (error) {
      console.error(`Error leyendo ${changedPath}:`, error);
    }
  }, DEBOUNCE_MS);
  debounceTimers.set(changedPath, timer);
}

export function unwatchFile(filePath: string): void {
  const absolutePath = path.resolve(filePath);
  const watcher = watchers.get(absolutePath);
  if (watcher) {
    void watcher.close();
    watchers.delete(absolutePath);
  }
}

export function unwatchAll(): void {
  for (const watcher of watchers.values()) void watcher.close();
  watchers.clear();
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
}

export function getWatchedFiles(): string[] { return Array.from(watchers.keys()); }
