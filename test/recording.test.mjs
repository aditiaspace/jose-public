import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../dist/workspace.js';
import { applicationHistory, listApplications, reportApplication } from '../dist/recording.js';

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'jose-recording-'));
  const ws = initWorkspace(join(root, 'workspace'));
  cleanups.push(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });
  return ws;
}

function addMaterial(ws, suffix = 'one', url = 'https://jobs.example.test/vacancies/fictional-role') {
  const vacancyId = `vacancy-${suffix}`;
  const materialId = `material-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  ws.store.create('vacancies', {
    id: vacancyId, company: 'Example Studio', role: 'Analyst', text: 'Fictional vacancy.', url,
    capturedAt: '2026-01-01T00:00:00.000Z', notes: '', possibleDuplicates: [],
  });
  const files = {
    html: `applications/${materialId}/resume.html`, pdf: `applications/${materialId}/resume.pdf`,
    letter: `applications/${materialId}/cover-letter.txt`, evidence: `applications/${materialId}/evidence.json`,
  };
  const fileHashes = Object.fromEntries(Object.values(files).map((path) => [path, 'fictional-hash']));
  ws.store.create('materials', {
    id: materialId, attemptId, vacancyId, profileId: 'profile-fictional', language: 'en',
    createdAt: '2026-01-01T00:00:00.000Z', files, fileHashes,
    manifestHash: 'fictional-hash', title: 'Fictional application',
  });
  return { vacancyId, materialId, attemptId };
}

test('a user report records the explicit status, leaves an unknown application date null, and appears in list/history', () => {
  const ws = workspace();
  const target = addMaterial(ws);

  const attempt = reportApplication(ws, { materialId: target.materialId, operationId: 'report-first' });

  assert.equal(attempt.id, target.attemptId);
  assert.equal(attempt.vacancyId, target.vacancyId);
  assert.equal(attempt.materialId, target.materialId);
  assert.equal(attempt.status, 'applied');
  assert.equal(attempt.provenance, 'user_reported');
  assert.equal(attempt.dateApplied, null);
  assert.deepEqual(listApplications(ws).map(({ id }) => id), [target.attemptId]);
  assert.equal(applicationHistory(ws, target.attemptId).length, 1);
  assert.equal(applicationHistory(ws, target.attemptId)[0].payload.status, 'applied');
});

test('application history includes persisted submission events for each attempt', () => {
  const ws = workspace();
  const target = addMaterial(ws);
  const attempt = reportApplication(ws, { materialId: target.materialId, operationId: 'report-history' });
  ws.store.event('submission_interrupted', attempt.id, { reason: 'Fictional interruption event.' });

  const history = applicationHistory(ws, attempt.id);

  assert.deepEqual(history.map((event) => event.kind), ['application_reported', 'submission_interrupted']);
  assert.deepEqual(applicationHistory(ws).map((event) => event.kind), ['application_reported', 'submission_interrupted']);
});

test('only the current material revision can be reported; historical revisions remain untouched', () => {
  const ws = workspace();
  const target = addMaterial(ws, 'revision');
  const historical = ws.store.require('materials', target.materialId);
  const current = { ...historical, id: 'material-current-revision', title: 'Fictional current revision' };
  ws.store.create('materials', current);
  ws.store.create('attempts', {
    id: target.attemptId, vacancyId: target.vacancyId, materialId: current.id,
    createdAt: '2026-01-01T00:00:00.000Z', status: 'content_approved',
  });

  assert.throws(() => reportApplication(ws, {
    materialId: historical.id, operationId: 'historical-material',
  }), /existing attempt|current material/i);
  const recorded = reportApplication(ws, { attemptId: target.attemptId, operationId: 'current-material' });

  assert.equal(recorded.materialId, current.id);
  assert.equal(recorded.status, 'applied');
  assert.deepEqual(ws.store.require('materials', historical.id), historical);
  assert.deepEqual(ws.store.require('materials', current.id), current);
  assert.equal(listApplications(ws).length, 1);
});

test('a repeated operation is idempotent and conflicting reuse is rejected', () => {
  const ws = workspace();
  const target = addMaterial(ws);
  const input = { materialId: target.materialId, status: 'applied', dateApplied: '2026-03-04', operationId: 'report-stable' };

  const first = reportApplication(ws, input);
  const again = reportApplication(ws, input);

  assert.equal(again.id, first.id);
  assert.equal(applicationHistory(ws, first.id).length, 1);
  assert.throws(() => reportApplication(ws, { ...input, status: 'screening' }), /operation/i);
  assert.equal(applicationHistory(ws, first.id).length, 1);
});

test('later factual status reports append history without replacing submitted material files', () => {
  const ws = workspace();
  const target = addMaterial(ws);
  const artifact = ws.store.require('materials', target.materialId).files.html;
  ws.write(artifact, '<p>Fictional submitted application</p>');
  reportApplication(ws, { ...target, status: 'applied', operationId: 'apply-1' });

  const updated = reportApplication(ws, { ...target, status: 'interview', operationId: 'interview-1' });
  const unchanged = reportApplication(ws, { ...target, operationId: 'status-omitted' });

  assert.equal(updated.status, 'interview');
  assert.equal(unchanged.status, 'interview');
  assert.equal(ws.read(artifact).toString(), '<p>Fictional submitted application</p>');
  assert.deepEqual(applicationHistory(ws, target.attemptId).map((event) => event.payload.status), ['applied', 'interview', 'interview']);
  assert.equal(listApplications(ws).length, 1);
});

test('a second material for the same vacancy requires explicit reapply and preserves the earlier attempt', () => {
  const ws = workspace();
  const firstTarget = addMaterial(ws, 'first');
  const secondTarget = addMaterial(ws, 'second');
  const secondMaterial = ws.store.require('materials', secondTarget.materialId);
  secondMaterial.vacancyId = firstTarget.vacancyId;
  ws.store.put('materials', secondMaterial);

  const first = reportApplication(ws, { materialId: firstTarget.materialId, operationId: 'apply-first' });
  assert.throws(() => reportApplication(ws, { materialId: secondTarget.materialId, operationId: 'apply-second' }), /reapply/i);
  const second = reportApplication(ws, { materialId: secondTarget.materialId, reapply: true, operationId: 'apply-again' });

  assert.notEqual(second.id, first.id);
  assert.equal(second.status, 'applied');
  assert.equal(listApplications(ws).length, 2);
  assert.equal(applicationHistory(ws, first.id).length, 1);
  assert.equal(applicationHistory(ws, second.id).length, 1);
});

test('portal observations require a status-bound same-origin success proof', () => {
  const ws = workspace();
  const target = addMaterial(ws, 'portal', 'https://id.jobstreet.com/id/job/fictional-123');
  const evidence = {
    targetUrl: 'https://id.jobstreet.com/myactivity/applied-jobs', status: 'applied',
    observedAt: '2026-04-02T09:30:00.000Z', portal: 'jobstreet', portalId: 'fictional-123',
    materialId: target.materialId, attemptId: target.attemptId, operationId: 'portal-submit-1',
  };

  assert.throws(() => reportApplication(ws, { ...target, provenance: 'portal_observed', operationId: 'missing-proof' }), /evidence/i);
  assert.throws(() => reportApplication(ws, {
    ...target, status: 'applied', provenance: 'portal_observed', operationId: 'bad-proof',
    evidence: { ...evidence, status: 'interview', operationId: 'bad-proof' },
  }), /evidence|status/i);
  assert.throws(() => reportApplication(ws, {
    ...target, status: 'applied', provenance: 'portal_observed', operationId: 'portal-secret',
    evidence: { ...evidence, targetUrl: 'https://id.jobstreet.com/myactivity?access_token=fictional', operationId: 'portal-secret' },
  }), /credentials|runtime tokens/i);
  const recorded = reportApplication(ws, {
    ...target, status: 'applied', provenance: 'portal_observed', operationId: evidence.operationId, evidence,
  });

  assert.equal(recorded.provenance, 'portal_observed');
  assert.equal(recorded.evidence.targetUrl, evidence.targetUrl);
  assert.equal(applicationHistory(ws, recorded.id).length, 1);
});

test('unknown fields and unsupported statuses are rejected at the report boundary', () => {
  const ws = workspace();
  const target = addMaterial(ws);

  assert.throws(() => reportApplication(ws, { ...target, operationId: 'invalid-1', status: 'maybe-hired' }), /status|invalid|input/i);
  assert.throws(() => reportApplication(ws, { ...target, operationId: 'invalid-2', approved: true }), /input|unrecognized|unknown/i);
});
