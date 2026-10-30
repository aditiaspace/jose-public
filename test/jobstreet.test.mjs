// Target check: node --test test/jobstreet.test.mjs (after build); intentionally not run by this slice.
// Fictional local pages exercise the browser flow; live Jobstreet selectors still require manual verification.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { JobstreetSession } from '../dist/jobstreet.js';
import { ApprovalNeeded, bindingFor, decideApproval, requestApproval } from '../dist/approval.js';
import { hash, id, now, stable } from '../dist/util.js';
import { initWorkspace } from '../dist/workspace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'jobstreet');
const fixture = name => readFileSync(join(FIXTURES, name));
const portal = { captcha: false, prefilled: false, boostSelected: false, submitWithoutSuccess: false, applyRequests: 0, submissions: 0 };
let server;
let baseUrl;

function send(res, status, bytes) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(bytes);
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', baseUrl ?? 'http://127.0.0.1');
    if (portal.captcha && (url.pathname === '/' || url.pathname.endsWith('/my-activity/saved-jobs'))) return send(res, 200, fixture('captcha.html'));
    if (url.pathname === '/') return send(res, 200, fixture('saved-jobs-1.html'));
    if (url.pathname === '/id/my-activity/saved-jobs') return send(res, 200, fixture(url.searchParams.get('page') === '2' ? 'saved-jobs-2.html' : 'saved-jobs-1.html'));
    if (url.pathname === '/job/fictional-101') return send(res, 200, fixture('detail-101.html'));
    if (url.pathname === '/job/fictional-202') return send(res, 200, fixture('detail-202.html'));
    if (url.pathname === '/job/fictional-101/apply') {
      portal.applyRequests++;
      return send(res, 200, fixture(portal.prefilled ? 'apply-prefilled.html' : 'apply.html'));
    }
    if (url.pathname === '/job/fictional-101/apply/review' && req.method === 'POST') {
      req.resume();
      portal.submissions++;
      return send(res, 200, fixture(portal.submitWithoutSuccess ? 'apply-review.html' : 'success.html'));
    }
    if (url.pathname === '/job/fictional-101/apply/review') return send(res, 200, fixture(portal.boostSelected ? 'apply-review-boost.html' : 'apply-review.html'));
    return send(res, 404, Buffer.from('Not found'));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
});

function resetPortal() {
  portal.captcha = false;
  portal.prefilled = false;
  portal.boostSelected = false;
  portal.submitWithoutSuccess = false;
  portal.applyRequests = 0;
  portal.submissions = 0;
}

function workspaceHarness() {
  const root = mkdtempSync(join(tmpdir(), 'jose-jobstreet-fixture-'));
  const ws = initWorkspace(resolve(root, 'workspace'));
  const session = new JobstreetSession(ws, { baseUrl, headless: true });
  return { root, ws, session };
}

async function closeHarness({ root, ws, session }) {
  await session.close();
  ws.close();
  rmSync(root, { recursive: true, force: true });
}

async function createApprovedMaterial(ws, vacancyInput = {}) {
  const settings = ws.settings();
  const profileId = id();
  const profile = { id: profileId, name: 'Fictional Candidate', facts: [], preferences: {}, openQuestions: [], createdAt: now(), confirmedAt: now() };
  settings.profileId = profileId;
  settings.onboarding = 'ready';
  ws.store.put('settings', settings);
  ws.store.create('profiles', profile);

  const vacancy = {
    id: vacancyInput.id ?? id(), company: vacancyInput.company ?? 'Example Metrics Lab', role: vacancyInput.role ?? 'Fictional Data Analyst', text: 'Fictional role for a local Playwright fixture.',
    url: vacancyInput.url ?? `${baseUrl}/job/fictional-101`, portalId: vacancyInput.portalId ?? 'jobstreet:101', capturedAt: now(), lifecycle: 'unknown', notes: '', possibleDuplicates: [],
  };
  ws.store.create('vacancies', vacancy);

  const attemptId = id();
  const materialId = id();
  const dir = `applications/fixtures/${materialId}`;
  const files = { html: `${dir}/cv.html`, pdf: `${dir}/cv.pdf`, letter: `${dir}/cover-letter.txt`, evidence: `${dir}/evidence.json` };
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Fictional Candidate, fictional analytics experience; no real person data.');
  const pdfBytes = Buffer.from(await pdf.save());
  const bytes = {
    [files.html]: Buffer.from('<h1>Fictional Candidate</h1><p>Imaginary analytics experience.</p>'),
    [files.pdf]: pdfBytes,
    [files.letter]: Buffer.from('Dear fictional hiring team,\n\nI am applying with fictional experience for this test.\n\nSincerely,\nFictional Candidate', 'utf8'),
    [files.evidence]: Buffer.from('{"fixture":"fictional"}', 'utf8'),
  };
  for (const [path, data] of Object.entries(bytes)) ws.write(path, data);
  const fileHashes = Object.fromEntries(Object.entries(bytes).map(([path, data]) => [path, hash(data)]));
  const material = {
    id: materialId, attemptId, vacancyId: vacancy.id, profileId, language: 'en', createdAt: now(), files, fileHashes,
    manifestHash: hash(stable({ materialId, attemptId, vacancyId: vacancy.id, profileId, language: 'en', files, fileHashes })), title: 'Fictional Data Analyst CV',
  };
  ws.store.create('attempts', { id: attemptId, vacancyId: vacancy.id, materialId, createdAt: now(), status: 'draft' });
  ws.store.create('materials', material);
  const approval = requestApproval(ws, 'content', materialId, bindingFor(ws, 'content', materialId), { title: material.title }, attemptId);
  decideApproval(ws, approval.id, true);
  return { material, vacancy, attemptId };
}

function approvePending(ws, action, entityId) {
  const approval = ws.store.list('approvals').find(item => item.action === action && item.entityId === entityId && item.state === 'pending');
  assert.ok(approval, `expected a pending ${action} approval`);
  return decideApproval(ws, approval.id, true);
}

test('fixture hosts are restricted to IPv4 loopback and login reports CAPTCHA honestly', async () => {
  resetPortal();
  const harness = workspaceHarness();
  try {
    assert.throws(() => new JobstreetSession(harness.ws, { baseUrl: 'http://example.invalid:1234' }), /test-only http:\/\/127\.0\.0\.1/);
    assert.throws(() => new JobstreetSession(harness.ws, { baseUrl: 'http://localhost:1234' }), /test-only http:\/\/127\.0\.0\.1/);
    portal.captcha = true;
    const result = await harness.session.login();
    assert.equal(result.state, 'blocked');
    assert.match(result.message, /manually|bypass/i);
  } finally { await closeHarness(harness); }
});

test('saved-job pagination captures actual details and preserves exact duplicates without overwriting', async () => {
  resetPortal();
  const harness = workspaceHarness();
  try {
    const first = await harness.session.scrape();
    assert.equal(first.state, 'scraped');
    assert.equal(first.pages, 2);
    assert.equal(first.captured.length, 2);
    const [saved] = harness.ws.store.list('vacancies');
    assert.equal(saved.role, 'Fictional Data Analyst');
    assert.equal(saved.company, 'Example Metrics Lab');
    assert.match(saved.text, /imaginary datasets/i);
    assert.equal(saved.portalId, 'jobstreet:101');

    saved.role = 'User-maintained fictional title';
    saved.notes = 'Keep this user note unchanged.';
    harness.ws.store.put('vacancies', saved);
    const duplicate = await harness.session.scrape();
    assert.equal(duplicate.state, 'scraped');
    assert.equal(duplicate.captured.length, 0);
    assert.ok(duplicate.duplicates.some(item => item.vacancyId === saved.id));
    const retained = harness.ws.store.require('vacancies', saved.id);
    assert.equal(retained.role, 'User-maintained fictional title');
    assert.equal(retained.notes, 'Keep this user note unchanged.');
  } finally { await closeHarness(harness); }
});

test('prepare requires disclosure before portal transition, rejects prefilled answers, and never follows external apply', async () => {
  resetPortal();
  const harness = workspaceHarness();
  try {
    const { material } = await createApprovedMaterial(harness.ws);
    await assert.rejects(harness.session.prepare(material.id, {}), error => error instanceof ApprovalNeeded && error.request.action === 'disclosure');
    assert.equal(portal.applyRequests, 0, 'the quick-apply transition must wait for disclosure approval');
    approvePending(harness.ws, 'disclosure', material.id);
    const missing = await harness.session.prepare(material.id, {});
    assert.equal(missing.state, 'answers_required');
    assert.equal(portal.submissions, 0);
  } finally { await closeHarness(harness); }

  resetPortal();
  const prefilled = workspaceHarness();
  try {
    const { material } = await createApprovedMaterial(prefilled.ws);
    await assert.rejects(prefilled.session.prepare(material.id, {}), ApprovalNeeded);
    approvePending(prefilled.ws, 'disclosure', material.id);
    portal.prefilled = true;
    const result = await prefilled.session.prepare(material.id, {});
    assert.equal(result.state, 'unsafe_prefill');
    assert.equal(portal.submissions, 0);
  } finally { await closeHarness(prefilled); }

  resetPortal();
  const external = workspaceHarness();
  try {
    const { material } = await createApprovedMaterial(external.ws, { id: 'external-fixture', role: 'Fictional Research Assistant', company: 'Imaginary Field Institute', url: `${baseUrl}/job/fictional-202` , portalId: 'jobstreet:202' });
    const result = await external.session.prepare(material.id, {});
    assert.equal(result.state, 'external_apply');
    assert.match(result.externalApplyUrl, /employer\.example\.invalid/);
    assert.equal(portal.applyRequests, 0);
  } finally { await closeHarness(external); }
});

test('review binds actual fields and exact artifacts; submit consumes once and records only observed success', async () => {
  resetPortal();
  const harness = workspaceHarness();
  try {
    const { material, vacancy, attemptId } = await createApprovedMaterial(harness.ws);
    await assert.rejects(harness.session.prepare(material.id, {}), error => error instanceof ApprovalNeeded && error.request.action === 'disclosure');
    approvePending(harness.ws, 'disclosure', material.id);
    const missing = await harness.session.prepare(material.id, {});
    assert.equal(missing.state, 'answers_required');
    await assert.rejects(harness.session.prepare(material.id, { salary_expectation: '10000000' }), error => error instanceof ApprovalNeeded && error.request.action === 'disclosure');
    approvePending(harness.ws, 'disclosure', material.id);
    const completed = await harness.session.prepare(material.id, { salary_expectation: '10000000' });
    assert.equal(completed.state, 'prepared');
    assert.equal(completed.finalReviewReached, true);
    assert.equal(completed.profileAndVisibilityUnchanged, true);
    assert.equal(completed.artifacts.cvFileName, 'cv.pdf');

    await assert.rejects(harness.session.review(material.id), error => error instanceof ApprovalNeeded && error.request.action === 'submit');
    approvePending(harness.ws, 'submit', material.id);
    const review = await harness.session.review(material.id);
    assert.equal(review.state, 'submit_approved');
    assert.equal(review.target.url, vacancy.url);
    assert.ok(review.selectedFiles.some(file => file.name === 'cv.pdf'));
    assert.ok(review.screening.some(question => question.key === 'salary_expectation' && question.values.some(value => value.value === '10000000')));

    const submitted = await harness.session.submit(material.id);
    assert.equal(submitted.state, 'portal_observed');
    assert.equal(submitted.attemptId, attemptId);
    assert.equal(portal.submissions, 1);
    assert.equal(harness.ws.store.require('attempts', attemptId).status, 'applied');
    const replay = await harness.session.submit(material.id);
    assert.equal(replay.state, 'portal_observed');
    assert.equal(portal.submissions, 1, 'a completed target must not be clicked a second time');
  } finally { await closeHarness(harness); }
});
 
test('an unobserved submit becomes uncertain and is never retried', async () => {
  resetPortal();
  const harness = workspaceHarness();
  try {
    const { material, attemptId } = await createApprovedMaterial(harness.ws);
    await assert.rejects(harness.session.prepare(material.id, {}), ApprovalNeeded);
    approvePending(harness.ws, 'disclosure', material.id);
    assert.equal((await harness.session.prepare(material.id, {})).state, 'answers_required');
    await assert.rejects(harness.session.prepare(material.id, { salary_expectation: '10000000' }), ApprovalNeeded);
    approvePending(harness.ws, 'disclosure', material.id);
    assert.equal((await harness.session.prepare(material.id, { salary_expectation: '10000000' })).state, 'prepared');
    await assert.rejects(harness.session.review(material.id), ApprovalNeeded);
    approvePending(harness.ws, 'submit', material.id);
    assert.equal((await harness.session.review(material.id)).state, 'submit_approved');

    portal.submitWithoutSuccess = true;
    const uncertain = await harness.session.submit(material.id);
    assert.equal(uncertain.state, 'submission_uncertain');
    assert.equal(harness.ws.store.require('attempts', attemptId).status, 'submission_uncertain');
    assert.equal(portal.submissions, 1);
    assert.equal((await harness.session.submit(material.id)).state, 'submission_uncertain');
    assert.equal(portal.submissions, 1, 'an uncertain application must not be blindly clicked again');
  } finally { await closeHarness(harness); }
});

test('a selected boost blocks the wizard and never reaches final approval', async () => {
  resetPortal();
  portal.boostSelected = true;
  const harness = workspaceHarness();
  try {
    const { material } = await createApprovedMaterial(harness.ws);
    await assert.rejects(harness.session.prepare(material.id, { salary_expectation: '10000000' }), ApprovalNeeded);
    approvePending(harness.ws, 'disclosure', material.id);
    const result = await harness.session.prepare(material.id, { salary_expectation: '10000000' });
    assert.equal(result.state, 'boost_selected');
    assert.equal(harness.ws.store.list('approvals').some(item => item.action === 'submit' && item.state === 'pending'), false);
    assert.equal(portal.submissions, 0);
  } finally { await closeHarness(harness); }
});
