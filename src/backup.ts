import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, linkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { Approval, Attempt, Material, Profile, Settings, Source } from './contracts.js';
import { bindingFor } from './approval.js';
import { Workspace } from './workspace.js';
import { assertPrivateRoot, hash, now, safePath, stable } from './util.js';

const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_JSON_BYTES = 192 * 1024 * 1024;
const MAX_DB_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CONTENT_BYTES = 96 * 1024 * 1024;
const MAX_FILES = 4096;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const IdentifierSchema = z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const PathSchema = z.string().min(1).max(32767).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const ArchiveDocumentSchema = z.object({
  path: z.string().min(1).max(4096),
  bytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
  sha256: z.string().regex(HEX_SHA256),
  data: z.string().max(MAX_JSON_BYTES),
}).strict();
const DatabaseImageSchema = z.object({
  bytes: z.number().int().nonnegative().max(MAX_DB_BYTES),
  sha256: z.string().regex(HEX_SHA256),
  data: z.string().max(MAX_JSON_BYTES),
}).strict();
const BackupArchiveSchema = z.object({
  format: z.literal('jose-public-backup'),
  version: z.literal(1),
  createdAt: z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)) && /T/.test(value)),
  workspaceId: IdentifierSchema,
  database: DatabaseImageSchema,
  files: z.array(ArchiveDocumentSchema).max(MAX_FILES),
}).strict();
const SettingsSchema = z.looseObject({ id: z.literal('settings'), workspaceId: IdentifierSchema });
const SourceSchema = z.looseObject({
  id: IdentifierSchema, name: z.string(), path: z.string().min(1).max(4096), hash: z.string().regex(HEX_SHA256),
  text: z.string(), warnings: z.array(z.string()), createdAt: z.string(),
});
const MaterialSchema = z.looseObject({
  id: IdentifierSchema, attemptId: IdentifierSchema, vacancyId: IdentifierSchema, profileId: IdentifierSchema,
  language: z.literal('en'), createdAt: z.string(),
  files: z.object({ html: z.string(), pdf: z.string(), letter: z.string(), evidence: z.string() }).strict(),
  fileHashes: z.record(z.string(), z.string().regex(HEX_SHA256)), manifestHash: z.string().regex(HEX_SHA256),
  title: z.string(), approvedAt: z.string().optional(),
});
function verifyMaterialManifest(material: z.infer<typeof MaterialSchema>): void {
  const expected = hash(stable({
    materialId: material.id,
    attemptId: material.attemptId,
    vacancyId: material.vacancyId,
    profileId: material.profileId,
    language: material.language,
    files: material.files,
    fileHashes: material.fileHashes,
  }));
  if (expected !== material.manifestHash) throw new Error(`Material ${material.id} manifest hash does not match its records.`);
}

type ArchiveDocument = z.infer<typeof ArchiveDocumentSchema>;
type SnapshotState = { workspaceId: string; sources: Source[]; materials: Material[] };
function invalidateApproval(ws: Workspace, approval: Approval, reason: string): void {
  const previousState = approval.state;
  approval.state = 'rejected';
  approval.decidedAt = now();
  ws.store.put('approvals', approval);
  ws.store.event('approval_invalidated_on_restore', approval.id, { action: approval.action, previousState, reason });
}
function requireProfileReview(ws: Workspace, profile: Profile, settings: Settings, reason: string): void {
  profile.facts = profile.facts.map((fact) => ({ ...fact, confirmed: false }));
  delete profile.confirmedAt;
  ws.store.put('profiles', profile);
  delete settings.profileId;
  settings.onboarding = 'awaiting_confirmation';
  ws.store.put<Settings>('settings', settings);
  ws.store.event('profile_confirmation_invalidated_on_restore', profile.id, { reason });
}

function sanitizeRestoredWorkspace(ws: Workspace): void {
  ws.store.tx(() => {
    const approvals = ws.store.list<Approval>('approvals');
    for (const approval of approvals) {
      if ((approval.action === 'disclosure' || approval.action === 'submit') &&
          (approval.state === 'pending' || approval.state === 'approved')) {
        invalidateApproval(ws, approval, 'Transient disclosure and submit approvals are invalid after restoring a backup.');
      }
    }

    const sourceIds = new Set(ws.store.list<Source>('sources').map((source) => source.id));
    const currentSettings = ws.settings();
    const currentProfile = currentSettings.profileId ? ws.store.get<Profile>('profiles', currentSettings.profileId) : null;
    const currentProfileValid = !!currentProfile && currentProfile.id === currentSettings.profileId &&
      !!currentProfile.confirmedAt && Array.isArray(currentProfile.facts) &&
      currentProfile.facts.every((fact) => fact.confirmed && sourceIds.has(fact.sourceId));
    if (currentSettings.onboarding === 'ready' && !currentProfileValid) {
      if (currentProfile?.confirmedAt && currentProfile.id === currentSettings.profileId) {
        requireProfileReview(ws, currentProfile, currentSettings, 'The confirmed profile or its source references are invalid after restore.');
      } else {
        const profileId = currentSettings.profileId;
        delete currentSettings.profileId;
        currentSettings.onboarding = 'awaiting_confirmation';
        ws.store.put<Settings>('settings', currentSettings);
        ws.store.event('profile_confirmation_invalidated_on_restore', profileId ?? 'settings', {
          reason: 'The current confirmed profile is missing or invalid after restore.',
        });
      }
    }
    for (const approval of approvals) {
      if (approval.action !== 'profile' || (approval.state !== 'pending' && approval.state !== 'approved')) continue;
      const profile = ws.store.get<Profile>('profiles', approval.entityId);
      const settings = ws.settings();
      const sourcesValid = !!profile && Array.isArray(profile.facts) &&
        profile.facts.every((fact) => sourceIds.has(fact.sourceId));
      let valid = false;
      if (profile && sourcesValid && approval.state === 'approved') {
        valid = !!profile.confirmedAt && settings.profileId === profile.id && settings.onboarding === 'ready' &&
          profile.facts.every((fact) => fact.confirmed);
      } else if (profile && sourcesValid && !profile.confirmedAt) {
        try {
          valid = bindingFor(ws, 'profile', profile.id) === approval.binding;
        } catch {
          valid = false;
        }
      }
      if (valid) continue;
      const previousState = approval.state;
      invalidateApproval(ws, approval, 'The restored profile approval or its source references are stale; review the profile again.');
      if (previousState === 'approved' && profile?.confirmedAt && settings.profileId === profile.id) {
        requireProfileReview(ws, profile, settings, 'The confirmed profile references source data that is missing or invalid.');
      }
    }

    for (const approval of approvals) {
      if (approval.action !== 'content' || (approval.state !== 'pending' && approval.state !== 'approved')) continue;
      let valid = false;
      const material = ws.store.get<Material>('materials', approval.entityId);
      const profile = material ? ws.store.get<Profile>('profiles', material.profileId) : null;
      const settings = ws.settings();
      const sourcesValid = !!profile && Array.isArray(profile.facts) &&
        profile.facts.every((fact) => fact.confirmed && sourceIds.has(fact.sourceId));
      if (material && approval.attemptId === material.attemptId && profile && profile.confirmedAt &&
          settings.profileId === profile.id && settings.onboarding === 'ready' && sourcesValid) {
        try {
          valid = bindingFor(ws, 'content', approval.entityId) === approval.binding;
        } catch {
          valid = false;
        }
      }
      if (!valid) invalidateApproval(ws, approval, 'The restored material, profile, source, or artifact hashes no longer match this approval; review the material again.');
    }

    for (const attempt of ws.store.list<Attempt>('attempts')) {
      if (attempt.status !== 'submitting') continue;
      attempt.status = 'submission_uncertain';
      ws.store.put('attempts', attempt);
      ws.store.event('submission_interrupted', attempt.id, {
        reason: 'Restored from backup; submission may have reached the portal. Check the portal manually before retrying.',
      });
    }
  });
}

function privateExistingDirectory(path: string, name: string): string {
  const absolutePath = PathSchema.parse(path);
  if (!isAbsolute(absolutePath)) throw new Error(`${name} must be an absolute path.`);
  const directory = assertPrivateRoot(absolutePath);
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${name} must be an existing directory.`);
  return directory;
}

function privateNewPath(path: string, name: string): string {
  const requested = resolve(PathSchema.parse(path));
  const parent = privateExistingDirectory(dirname(requested), `${name} parent`);
  const target = resolve(parent, basename(requested));
  try {
    lstatSync(target);
    throw new Error(`${name} already exists; overwriting is not allowed.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

function archivePath(value: string, directory: 'sources' | 'applications' | 'context'): string {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    throw new Error('Backup contains an unsafe document path.');
  }
  const pieces = value.split('/');
  if (pieces.length < 2 || pieces[0] !== directory || pieces.some((piece) =>
    !piece || piece === '.' || piece === '..' || piece.endsWith('.') || piece.endsWith(' ') || piece.includes(':') ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(piece)) ||
      (directory === 'context' && (pieces.length !== 2 || pieces[1] !== 'current.json'))) {
    throw new Error(`Backup document paths must stay inside ${directory}/.`);
  }
  return value;
}

function decodeBase64(value: string, expectedBytes: number, expectedHash: string, name: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Backup ${name} has invalid base64 data.`);
  }
  const data = Buffer.from(value, 'base64');
  if (data.length !== expectedBytes || data.toString('base64') !== value || hash(data) !== expectedHash) {
    throw new Error(`Backup ${name} failed size or SHA-256 validation.`);
  }
  return data;
}

function snapshotState(databasePath: string): SnapshotState {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA query_only=ON;');
    const checks = database.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    if (checks.length !== 1 || Object.values(checks[0]!)[0] !== 'ok') throw new Error('Backup SQLite snapshot failed integrity validation.');
    const read = (kind: string) => (database.prepare('SELECT id,data FROM records WHERE kind=? ORDER BY rowid').all(kind) as Array<{ id: string; data: string }>).map(({ id, data }) => {
      const record = JSON.parse(data) as unknown;
      if (!record || typeof record !== 'object' || Array.isArray(record) || !('id' in record) || record.id !== id) {
        throw new Error(`Backup ${kind} record identity does not match its SQLite key.`);
      }
      return record;
    });
    const settingsRows = read('settings');
    if (settingsRows.length !== 1) throw new Error('Backup must contain exactly one workspace settings record.');
    const settings = SettingsSchema.parse(settingsRows[0]);
    const sources = read('sources');
    const materials = read('materials');
    if (sources.length + materials.length > MAX_FILES) throw new Error('Backup contains too many source or material records.');
    return {
      workspaceId: settings.workspaceId,
      sources: sources.map((record) => SourceSchema.parse(record) as Source),
      materials: materials.map((record) => MaterialSchema.parse(record) as Material),
    };
  } finally {
    database.close();
  }
}

function fileStats(path: string, maxBytes: number): Buffer {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) throw new Error(`Unsafe or oversized backup document: ${path}`);
  const data = readFileSync(path);
  if (data.length > maxBytes) throw new Error(`Oversized backup document: ${path}`);
  return data;
}

function collectContext(ws: Workspace, files: Map<string, { path: string; data: Buffer; sha256: string }>, excludedPath: string): void {
  const relativePath = archivePath('context/current.json', 'context');
  const full = ws.path(relativePath);
  try {
    lstatSync(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (resolve(full) === excludedPath) return;
  const data = fileStats(full, MAX_FILE_BYTES);
  const key = relativePath.toLowerCase();
  const previous = files.get(key);
  if (previous && previous.path !== relativePath) throw new Error('Backup contains case-colliding document paths.');
  files.set(key, { path: relativePath, data, sha256: hash(data) });
}

function collectDocuments(ws: Workspace, state: SnapshotState, excludedPath: string): ArchiveDocument[] {
  const files = new Map<string, { path: string; data: Buffer; sha256: string }>();
  const add = (value: string, directory: 'sources' | 'applications', expectedHash?: string): void => {
    const relativePath = archivePath(value, directory);
    const key = relativePath.toLowerCase();
    const previous = files.get(key);
    if (previous && previous.path !== relativePath) throw new Error('Backup contains case-colliding document paths.');
    const full = ws.path(relativePath);
    if (resolve(full) === excludedPath) return;
    const data = fileStats(full, MAX_FILE_BYTES);
    const actualHash = hash(data);
    if (expectedHash && actualHash !== expectedHash) throw new Error(`Workspace document hash changed: ${relativePath}`);
    if (previous && previous.sha256 !== actualHash) throw new Error(`Workspace document changed during backup: ${relativePath}`);
    files.set(key, { path: relativePath, data, sha256: actualHash });
  };

  for (const rawSource of state.sources) {
    const source = SourceSchema.parse(rawSource);
    add(source.path, 'sources', source.hash);
  }
  for (const rawMaterial of state.materials) {
    const material = MaterialSchema.parse(rawMaterial);
    verifyMaterialManifest(material);
    const paths = Object.values(material.files);
    if (paths.length !== 4 || new Set(paths).size !== 4 || Object.keys(material.fileHashes).length !== paths.length) {
      throw new Error(`Material ${material.id} has an invalid document manifest.`);
    }
    for (const path of paths) {
      if (!Object.hasOwn(material.fileHashes, path)) throw new Error(`Material ${material.id} has no hash for ${path}.`);
      add(path, 'applications', material.fileHashes[path]);
    }
  }
  collectContext(ws, files, excludedPath);
  if (files.size > MAX_FILES) throw new Error('Workspace has too many backup documents.');
  let total = 0;
  const output = [...files.values()].sort((left, right) => left.path.localeCompare(right.path)).map(({ path, data, sha256 }) => {
    total += data.length;
    if (total > MAX_CONTENT_BYTES) throw new Error('Workspace documents exceed the backup size limit.');
    return { path, bytes: data.length, sha256, data: data.toString('base64') };
  });
  return output;
}

function validateArchiveFiles(state: SnapshotState, files: ArchiveDocument[], decoded: Map<string, Buffer>): void {
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  let total = 0;
  for (const file of files) {
    const allowedDirectory = file.path.startsWith('sources/') ? 'sources'
      : file.path.startsWith('applications/') ? 'applications'
        : file.path.startsWith('context/') ? 'context' : null;
    if (!allowedDirectory) throw new Error('Backup contains a document outside sources/, applications/, or context/.');
    const path = archivePath(file.path, allowedDirectory);
    const folded = path.toLowerCase();
    if (paths.has(path) || foldedPaths.has(folded)) throw new Error('Backup contains duplicate or case-colliding paths.');
    paths.add(path);
    foldedPaths.add(folded);
    const bytes = decodeBase64(file.data, file.bytes, file.sha256, path);
    total += bytes.length;
    if (total > MAX_CONTENT_BYTES) throw new Error('Backup documents exceed the size limit.');
    decoded.set(path, bytes);
  }

  const required = new Set<string>();
  for (const rawSource of state.sources) {
    const source = SourceSchema.parse(rawSource);
    const path = archivePath(source.path, 'sources');
    const data = decoded.get(path);
    if (!data || hash(data) !== source.hash) throw new Error(`Backup is missing or has changed source ${path}.`);
    required.add(path);
  }
  for (const rawMaterial of state.materials) {
    const material = MaterialSchema.parse(rawMaterial);
    verifyMaterialManifest(material);
    const pathsForMaterial = Object.values(material.files);
    if (pathsForMaterial.length !== 4 || new Set(pathsForMaterial).size !== 4 || Object.keys(material.fileHashes).length !== pathsForMaterial.length) {
      throw new Error(`Backup material ${material.id} has an invalid document manifest.`);
    }
    for (const value of pathsForMaterial) {
      const path = archivePath(value, 'applications');
      const data = decoded.get(path);
      if (!Object.hasOwn(material.fileHashes, path) || !data || hash(data) !== material.fileHashes[path]) {
        throw new Error(`Backup is missing or has changed application document ${path}.`);
      }
      required.add(path);
    }
  }
  for (const path of paths) {
    if ((path.startsWith('sources/') || path.startsWith('applications/')) && !required.has(path)) {
      throw new Error(`Backup contains an unreferenced document: ${path}`);
    }
  }
}

function validateDatabaseImage(data: Buffer, expectedWorkspaceId: string): SnapshotState {
  if (data.length > MAX_DB_BYTES) throw new Error('Backup SQLite image exceeds the size limit.');
  const directory = mkdtempSync(join(tmpdir(), 'jose-restore-check-'));
  const databasePath = join(directory, 'snapshot.sqlite');
  try {
    writeFileSync(databasePath, data, { mode: 0o600, flag: 'wx' });
    const state = snapshotState(databasePath);
    if (state.workspaceId !== expectedWorkspaceId) throw new Error('Backup workspace ID does not match its SQLite snapshot.');
    return state;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function exportBackup(ws: Workspace, path: string): Promise<Record<string, unknown>> {
  assertPrivateRoot(ws.root);
  const outputPath = privateNewPath(path, 'Backup output');
  const tempDirectory = mkdtempSync(join(tmpdir(), 'jose-backup-'));
  const snapshotPath = join(tempDirectory, 'snapshot.sqlite');
  let temporaryOutput: string | undefined;
  try {
    await sqliteBackup(ws.store.db, snapshotPath);
    const database = fileStats(snapshotPath, MAX_DB_BYTES);
    const state = snapshotState(snapshotPath);
    const documents = collectDocuments(ws, state, outputPath);
    const totalBytes = database.length + documents.reduce((total, file) => total + file.bytes, 0);
    if (totalBytes > MAX_CONTENT_BYTES) throw new Error('Workspace state exceeds the backup size limit.');
    const image = {
      bytes: database.length,
      sha256: hash(database),
      data: database.toString('base64'),
    };
    const envelope = {
      format: 'jose-public-backup',
      version: 1,
      createdAt: now(),
      workspaceId: state.workspaceId,
      database: image,
      files: documents,
    };
    const json = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (json.length > MAX_JSON_BYTES) throw new Error('Backup JSON exceeds the size limit.');
    const compressed = gzipSync(json, { level: 9 });
    if (compressed.length > MAX_ARCHIVE_BYTES) throw new Error('Compressed backup exceeds the size limit.');
    temporaryOutput = `${outputPath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryOutput, compressed, { mode: 0o600, flag: 'wx' });
    linkSync(temporaryOutput, outputPath);
    unlinkSync(temporaryOutput);
    temporaryOutput = undefined;
    return {
      path: outputPath,
      workspaceId: state.workspaceId,
      createdAt: envelope.createdAt,
      bytes: compressed.length,
      sha256: hash(compressed),
      documents: documents.length,
    };
  } finally {
    try {
      if (temporaryOutput) unlinkSync(temporaryOutput);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  }
}

export async function restoreBackup(file: string, target: string): Promise<Workspace> {
  const requestedFile = resolve(PathSchema.parse(file));
  const archiveParent = privateExistingDirectory(dirname(requestedFile), 'Backup file parent');
  const backupFile = resolve(archiveParent, basename(requestedFile));
  const backupStats = lstatSync(backupFile);
  if (!backupStats.isFile() || backupStats.isSymbolicLink() || backupStats.size > MAX_ARCHIVE_BYTES) {
    throw new Error('Backup must be a regular file within the archive size limit.');
  }
  const destination = privateNewPath(target, 'Restore destination');
  const compressed = readFileSync(backupFile);
  if (compressed.length > MAX_ARCHIVE_BYTES) throw new Error('Backup exceeds the compressed size limit.');
  const json = gunzipSync(compressed, { maxOutputLength: MAX_JSON_BYTES });
  const archive = BackupArchiveSchema.parse(JSON.parse(json.toString('utf8')));
  const databaseBytes = decodeBase64(archive.database.data, archive.database.bytes, archive.database.sha256, 'SQLite image');
  const state = validateDatabaseImage(databaseBytes, archive.workspaceId);
  const decoded = new Map<string, Buffer>();
  validateArchiveFiles(state, archive.files, decoded);
  const totalBytes = databaseBytes.length + [...decoded.values()].reduce((total, data) => total + data.length, 0);
  if (totalBytes > MAX_CONTENT_BYTES) throw new Error('Backup contents exceed the size limit.');

  mkdirSync(destination, { mode: 0o700 });
  let restoredWorkspace: Workspace | undefined;
  try {
    const databasePath = safePath(destination, 'state/jose.sqlite');
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    writeFileSync(databasePath, databaseBytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(safePath(destination, '.jose-workspace'), '1\n', { mode: 0o600, flag: 'wx' });
    for (const [path, data] of decoded) {
      const destinationPath = safePath(destination, path);
      mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
      writeFileSync(destinationPath, data, { mode: 0o600, flag: 'wx' });
    }
    restoredWorkspace = new Workspace(destination);
    sanitizeRestoredWorkspace(restoredWorkspace);
    return restoredWorkspace;
  } catch (error) {
    restoredWorkspace?.close();
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
