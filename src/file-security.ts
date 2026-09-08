import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_FILE_BYTES = 1024 * 1024;

export interface FileSnapshot {
  filePath: string;
  rootPath: string;
  content: string;
  hash: string;
  size: number;
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function realPathWithinRoot(filePath: string, rootPath: string): boolean {
  try {
    const realRoot = fs.realpathSync(rootPath);
    const realFile = fs.realpathSync(filePath);
    return isWithinRoot(realFile, realRoot);
  } catch {
    return false;
  }
}

export function assertAuthorizedPath(filePath: string, rootPath: string): { filePath: string; rootPath: string } {
  const absoluteFile = path.resolve(filePath);
  const absoluteRoot = path.resolve(rootPath);

  if (!isWithinRoot(absoluteFile, absoluteRoot)) {
    throw new Error('La ruta queda fuera de la raíz autorizada');
  }

  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('La raíz autorizada no es un directorio regular');
  }

  const fileStat = fs.lstatSync(absoluteFile);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error('El archivo debe ser regular y no simbólico');
  }
  if (fileStat.nlink !== 1) {
    throw new Error('No se aceptan archivos con hardlinks');
  }
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error(`El archivo supera el límite de ${MAX_FILE_BYTES} bytes`);
  }
  if (!realPathWithinRoot(absoluteFile, absoluteRoot)) {
    throw new Error('La ruta real queda fuera de la raíz autorizada');
  }

  return { filePath: absoluteFile, rootPath: absoluteRoot };
}

export function readAuthorizedFile(filePath: string, rootPath: string, maxBytes = MAX_FILE_BYTES): FileSnapshot {
  const authorized = assertAuthorizedPath(filePath, rootPath);
  const buffer = fs.readFileSync(authorized.filePath);
  if (buffer.byteLength > maxBytes) {
    throw new Error(`El archivo supera el límite de ${maxBytes} bytes`);
  }

  const content = buffer.toString('utf8');
  return {
    ...authorized,
    content,
    hash: hashBuffer(buffer),
    size: buffer.byteLength,
  };
}

export function hashBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function hashContent(content: string): string {
  return hashBuffer(Buffer.from(content, 'utf8'));
}

export function atomicWriteAuthorizedFile(
  filePath: string,
  rootPath: string,
  content: string,
  expectedHash: string,
): FileSnapshot {
  const authorized = assertAuthorizedPath(filePath, rootPath);
  const current = readAuthorizedFile(authorized.filePath, authorized.rootPath);
  if (current.hash !== expectedHash) {
    throw new Error('El archivo cambió antes de aplicar el cambio');
  }

  const data = Buffer.from(content, 'utf8');
  if (data.byteLength > MAX_FILE_BYTES) {
    throw new Error(`El archivo supera el límite de ${MAX_FILE_BYTES} bytes`);
  }

  const originalMode = fs.statSync(authorized.filePath).mode & 0o777;
  const temporaryPath = path.join(
    authorized.rootPath,
    `.visual-inspector-${path.basename(authorized.filePath)}-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', originalMode);
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, authorized.filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporaryPath); } catch { /* no-op */ }
    throw error;
  }

  return readAuthorizedFile(authorized.filePath, authorized.rootPath);
}

