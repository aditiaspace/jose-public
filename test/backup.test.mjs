import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportBackup, restoreBackup } from '../dist/backup.js';
import { initWorkspace, INSTALL_ROOT } from '../dist/workspace.js';
import { hash, stable } from '../dist/util.js';
import { bindingFor } from '../dist/approval.js';

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'jose-backup-'));
  const ws = initWorkspace(join(root, 'workspace'));
  cleanups.push(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, ws };
}

function addRecords(ws) {
  const sourcePath = 'sources/fictional-source.txt';
  const sourceBytes = Buffer.from('A neutral fictional resume source.');
  ws.write(sourcePath, sourceBytes);
  ws.store.create('sources', {
    id: 'source-fictional', name: 'Fictional source', path: sourcePath, hash: hash(sourceBytes),
    text: 'A neutral fictional resume source.', warnings: [], createdAt: '2026-01-02T03:04:05.000Z',
  });

  const attemptId = 'attempt-fictional';
  const materialId = 'material-fictional';
  const files = {
    html: `applications/${attemptId}/${materialId}/resume.html`,
    pdf: `applications/${attemptId}/${materialId}/resume.pdf`,
    letter: `applications/${attemptId}/${materialId}/cover-letter.txt`,
    evidence: `applications/${attemptId}/${materialId}/evidence.json`,
  };
  const contents = {
    html: '<p>Fictional application</p>',
    pdf: 'fictional PDF bytes',
    letter: 'A fictional cover letter.',
    evidence: '{"claims":[]}',
  };
  const fileHashes = {};
  for (const key of Object.keys(files)) {
    const bytes = Buffer.from(contents[key]);
    ws.write(files[key], bytes);
    fileHashes[files[key]] = hash(bytes);
  }
  const manifestHash = hash(stable({
    materialId, attemptId, vacancyId: 'vacancy-fictional', profileId: 'profile-fictional',
    language: 'en', files, fileHashes,
  }));
  ws.store.create('materials', {
    id: materialId, attemptId, vacancyId: 'vacancy-fictional', profileId: 'profile-fictional',
    language: 'en', createdAt: '2026-01-02T03:04:05.000Z', files, fileHashes,
    manifestHash, title: 'Fictional application',
  });
  ws.store.create('attempts', {
    id: attemptId, vacancyId: 'vacancy-fictional', materialId, createdAt: '2026-01-02T03:04:05.000Z',
    status: 'content_approved', dateApplied: null,
  });
  ws.write('context/current.json', '{"workspace":"fictional"}');
  ws.write('browser/fixture.json', 'PRIVATE_BROWSER_SENTINEL');
  ws.write('client-config/fixture.json', 'PRIVATE_CLIENT_CONFIG_SENTINEL');
  ws.write('.jose-runtime/fixture.json', 'PRIVATE_RUNTIME_SENTINEL');
  ws.write('unrelated.txt', 'UNRELATED_SENTINEL');
  ws.write('sources/unreferenced.txt', 'UNREFERENCED_SOURCE_SENTINEL');
  ws.write('applications/unreferenced.txt', 'UNREFERENCED_APPLICATION_SENTINEL');
  return { sourcePath, sourceBytes, attemptId, materialId, files, contents };
}

test('export contains a gzip SQLite snapshot and only referenced private documents plus generated context', async () => {
  const { root, ws } = setup();
  const records = addRecords(ws);
  const backupPath = join(root, 'workspace-backup.jose.gz');

  const result = await exportBackup(ws, backupPath);
  const archive = JSON.parse(gunzipSync(readFileSync(backupPath)).toString('utf8'));

  assert.equal(result.workspaceId, ws.settings().workspaceId);
  assert.equal(archive.format, 'jose-public-backup');
  assert.equal(archive.version, 1);
  assert.equal(archive.workspaceId, ws.settings().workspaceId);
  assert.ok(archive.database.bytes > 0);
  assert.equal(hash(Buffer.from(archive.database.data, 'base64')), archive.database.sha256);
  assert.deepEqual(new Set(archive.files.map(({ path }) => path)), new Set([
    records.sourcePath, ...Object.values(records.files), 'context/current.json',
  ]));
  const serialized = JSON.stringify(archive);
  for (const secret of [
    'PRIVATE_BROWSER_SENTINEL', 'PRIVATE_CLIENT_CONFIG_SENTINEL', 'PRIVATE_RUNTIME_SENTINEL',
    'UNRELATED_SENTINEL', 'UNREFERENCED_SOURCE_SENTINEL', 'UNREFERENCED_APPLICATION_SENTINEL',
  ]) assert.equal(serialized.includes(secret), false);
  await assert.rejects(exportBackup(ws, backupPath), /exists|overwrite/i);
  await assert.rejects(exportBackup(ws, join(INSTALL_ROOT, 'not-a-real-backup.jose.gz')), /Git|private/i);
});

test('restore preserves workspace identity, records, and every artifact hash in a new destination', async () => {
  const { root, ws } = setup();
  const records = addRecords(ws);
  const backupPath = join(root, 'workspace-backup.jose.gz');
  const restoreParent = join(root, 'restores');
  const restoredRoot = join(restoreParent, 'restored-workspace');
  mkdirSync(restoreParent);
  await exportBackup(ws, backupPath);

  const restored = await restoreBackup(backupPath, restoredRoot);
  cleanups.push(() => restored.close());

  assert.equal(restored.settings().workspaceId, ws.settings().workspaceId);
  assert.deepEqual(restored.store.require('sources', 'source-fictional'), ws.store.require('sources', 'source-fictional'));
  assert.deepEqual(restored.store.require('materials', records.materialId), ws.store.require('materials', records.materialId));
  assert.deepEqual(restored.store.require('attempts', records.attemptId), ws.store.require('attempts', records.attemptId));
  assert.equal(hash(restored.read(records.sourcePath)), hash(records.sourceBytes));
  for (const [key, path] of Object.entries(records.files)) assert.equal(hash(restored.read(path)), hash(Buffer.from(records.contents[key])));
  assert.equal(restored.read('context/current.json').toString(), '{"workspace":"fictional"}');
  assert.equal(existsSync(join(restoredRoot, 'browser')), false);
  assert.equal(existsSync(join(restoredRoot, 'client-config')), false);
  assert.equal(existsSync(join(restoredRoot, '.jose-runtime')), false);
});

test('restore revokes transient portal permissions and marks an interrupted submission uncertain', async () => {
  const { root, ws } = setup();
  const records = addRecords(ws);
  const profile = {
    id: 'profile-fictional', name: 'Fictional profile',
    facts: [{
      id: 'fact-fictional', category: 'experience', statement: 'Fictional experience.',
      sourceId: 'source-fictional', excerpt: 'Fictional source excerpt.', confirmed: true,
    }],
    preferences: {}, openQuestions: [], createdAt: '2026-01-02T03:04:05.000Z',
    confirmedAt: '2026-01-02T03:05:00.000Z',
  };
  ws.store.create('profiles', profile);
  const staleProfile = {
    id: 'profile-stale-source', name: 'Fictional profile with missing source',
    facts: [{
      id: 'fact-stale', category: 'experience', statement: 'Fictional unsupported fact.',
      sourceId: 'source-missing', excerpt: 'Missing fictional source.', confirmed: false,
    }],
    preferences: {}, openQuestions: [], createdAt: '2026-01-02T03:04:05.000Z',
  };
  ws.store.create('profiles', staleProfile);
  const settings = ws.settings();
  settings.profileId = profile.id;
  settings.onboarding = 'ready';
  ws.store.put('settings', settings);
  const contentBinding = bindingFor(ws, 'content', records.materialId);
  const attempt = ws.store.require('attempts', records.attemptId);
  attempt.status = 'submitting';
  attempt.submissionBinding = 'fictional-submit-binding';
  ws.store.put('attempts', attempt);

  const approval = (id, action, entityId, state, binding, attemptId) => ({
    id, action, entityId, ...(attemptId ? { attemptId } : {}), binding, summary: {},
    state, createdAt: '2026-01-02T03:05:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  ws.store.create('approvals', approval('approval-profile', 'profile', profile.id, 'approved', 'fictional-profile-history'));
  ws.store.create('approvals', approval('approval-profile-stale', 'profile', staleProfile.id, 'pending', 'fictional-stale-profile'));
  ws.store.create('approvals', approval('approval-content', 'content', records.materialId, 'approved', contentBinding, records.attemptId));
  ws.store.create('approvals', approval('approval-content-stale', 'content', records.materialId, 'approved', '0'.repeat(64), records.attemptId));
  ws.store.create('approvals', approval('approval-disclosure', 'disclosure', records.attemptId, 'pending', 'fictional-disclosure-binding'));
  ws.store.create('approvals', approval('approval-submit', 'submit', records.materialId, 'approved', 'fictional-submit-binding', records.attemptId));

  const backupPath = join(root, 'workspace-backup.jose.gz');
  const restoreParent = join(root, 'restores');
  const restoredRoot = join(restoreParent, 'restored-workspace');
  mkdirSync(restoreParent);
  await exportBackup(ws, backupPath);
  const restored = await restoreBackup(backupPath, restoredRoot);
  cleanups.push(() => restored.close());

  assert.equal(restored.store.require('attempts', records.attemptId).status, 'submission_uncertain');
  assert.equal(restored.store.require('approvals', 'approval-disclosure').state, 'rejected');
  assert.equal(restored.store.require('approvals', 'approval-submit').state, 'rejected');
  assert.equal(restored.store.require('approvals', 'approval-profile').state, 'approved');
  assert.equal(restored.store.require('approvals', 'approval-content').state, 'approved');
  assert.equal(restored.store.require('approvals', 'approval-content-stale').state, 'rejected');
  assert.equal(restored.store.require('approvals', 'approval-profile-stale').state, 'rejected');
  const invalidations = restored.store.events().filter(({ kind }) => kind === 'approval_invalidated_on_restore');
  assert.equal(invalidations.length, 4);
  assert.ok(invalidations.every(({ payload }) => typeof payload.reason === 'string' && payload.reason.length > 0));
  assert.ok(restored.store.events(records.attemptId).some(({ kind, payload }) =>
    kind === 'submission_interrupted' && /Restored from backup/.test(payload.reason)));
});

test('restore rejects traversal, modified hashes, and an existing destination before writing files', async () => {
  const { root, ws } = setup();
  addRecords(ws);
  const backupPath = join(root, 'workspace-backup.jose.gz');
  const maliciousPath = join(root, 'malicious-backup.jose.gz');
  const restoreParent = join(root, 'restores');
  const target = join(restoreParent, 'new-workspace');
  const existing = join(restoreParent, 'existing-workspace');
  mkdirSync(restoreParent);
  await exportBackup(ws, backupPath);
  const original = JSON.parse(gunzipSync(readFileSync(backupPath)).toString('utf8'));

  const traversal = structuredClone(original);
  traversal.files[0].path = '../outside.txt';
  writeFileSync(maliciousPath, gzipSync(Buffer.from(JSON.stringify(traversal))));
  await assert.rejects(restoreBackup(maliciousPath, target), /path|sources|applications|context/i);
  assert.equal(existsSync(target), false);

  const tampered = structuredClone(original);
  tampered.files[0].data = Buffer.from('changed fictional document').toString('base64');
  writeFileSync(maliciousPath, gzipSync(Buffer.from(JSON.stringify(tampered))));
  await assert.rejects(restoreBackup(maliciousPath, target), /hash|validation/i);
  assert.equal(existsSync(target), false);
  const oversized = structuredClone(original);
  oversized.database.bytes = 64 * 1024 * 1024 + 1;
  writeFileSync(maliciousPath, gzipSync(Buffer.from(JSON.stringify(oversized))));
  await assert.rejects(restoreBackup(maliciousPath, target), /too big|maximum|size|limit/i);
  assert.equal(existsSync(target), false);

  mkdirSync(existing);
  await assert.rejects(restoreBackup(backupPath, existing), /exists|overwrite/i);
  assert.equal(existsSync(existing), true);
  await assert.rejects(restoreBackup(backupPath, join(INSTALL_ROOT, 'not-a-real-restore')), /Git|private/i);
});
