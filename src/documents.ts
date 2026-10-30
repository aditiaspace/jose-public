import { basename, extname, resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { z } from 'zod';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import type { Source } from './contracts.js';
import type { Workspace } from './workspace.js';
import { hash, id, now } from './util.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 1_000_000;
const TEXT_EXTENSIONS: Record<string, true> = { '.txt': true, '.text': true, '.md': true };
const SOURCE_PATH_INPUT = z.string().trim().min(1).max(4096).refine(path => !path.includes('\0'), 'Source path contains an invalid character.');
const PDF_BYTES_INPUT = z.instanceof(Uint8Array).refine(bytes => bytes.length > 0 && bytes.length <= MAX_FILE_BYTES, 'PDF input must contain 1 byte to 20 MB.');

export async function extractPdfText(data: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: PDF_BYTES_INPUT.parse(new Uint8Array(data)) });
  try {
    return (await parser.getText()).text.replace(/\s*--\s*\d+\s+of\s+\d+\s*--\s*/gu, '\n').trim();
  } finally {
    await parser.destroy();
  }
}

export async function importSource(ws: Workspace, file: string): Promise<Source> {
  const absolute = resolve(SOURCE_PATH_INPUT.parse(file));
  const extension = extname(absolute).toLowerCase();
  if (extension !== '.pdf' && extension !== '.docx' && TEXT_EXTENSIONS[extension] !== true) {
    throw new Error('Unsupported source type. Import a PDF, DOCX, TXT, TEXT, or Markdown file.');
  }

  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    throw new Error(`Cannot read the selected source file: ${basename(absolute)}.`, { cause: error });
  }
  if (!info.isFile()) throw new Error('The selected source path is not a file.');
  if (info.size === 0) throw new Error('The selected source file is empty.');
  if (info.size > MAX_FILE_BYTES) throw new Error(`Source file exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`);

  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch (error) {
    throw new Error(`Cannot read the selected source file: ${basename(absolute)}.`, { cause: error });
  }
  if (bytes.length === 0) throw new Error('The selected source file is empty.');
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`Source file exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`);

  let extracted: string;
  const warnings: string[] = [];
  try {
    if (extension === '.pdf') {
      extracted = await extractPdfText(bytes);
    } else if (extension === '.docx') {
      const result = await mammoth.extractRawText({ buffer: bytes });
      const errors = result.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(message => message.message).join('; '));
      warnings.push(...result.messages.map(message => `${message.type}: ${message.message}`));
      extracted = result.value;
    } else {
      extracted = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
  } catch (error) {
    throw new Error(`Could not extract text from ${basename(absolute)}. The file may be malformed or password-protected.`, { cause: error });
  }

  if (extracted.length > MAX_TEXT_CHARS) throw new Error(`Extracted source text exceeds the ${MAX_TEXT_CHARS.toLocaleString()} character limit.`);
  if (!extracted.trim()) {
    if (extension === '.pdf') throw new Error('This PDF contains no selectable text. OCR is not available; import a text-based PDF, DOCX, or text file.');
    throw new Error('The selected document contains no readable text.');
  }

  const sourceId = id();
  const source: Source = {
    id: sourceId,
    name: basename(absolute),
    path: `sources/${sourceId}${extension}`,
    hash: hash(bytes),
    text: extracted,
    warnings,
    createdAt: now(),
  };
  ws.write(source.path, bytes);
  try {
    ws.store.tx(() => {
      ws.store.create<Source>('sources', source);
      ws.store.event('source_imported', source.id, { path: source.path, hash: source.hash, warnings: source.warnings });
    });
  } catch (error) {
    try { unlinkSync(ws.path(source.path)); } catch { /* preserve the original database error */ }
    throw error;
  }
  return source;
}
