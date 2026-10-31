import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import mammoth from 'mammoth';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { decideApproval, verifyMaterial } from '../dist/approval.js';
import { importSource } from '../dist/documents.js';
import { captureVacancy, createMaterial, exportMaterial } from '../dist/materials.js';
import { getContext, proposeProfile, refreshContext } from '../dist/profile.js';
import { initWorkspace } from '../dist/workspace.js';

const SAMPLE_CV = `SYNTHETIC EXAMPLE ONLY — not a real person's CV.\n\nExample Candidate\n\nCompleted a simulated customer-support exercise organizing 12 sample tickets by issue type.\nUsed a spreadsheet to summarize the ticket categories for the exercise.\n`;

function temporaryWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'jose-public-test-'));
  const ws = initWorkspace(root);
  const settings=ws.settings();settings.editingMode='chat';settings.resumeFormat='bullet';ws.store.put('settings',settings);
  t.after(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, ws };
}

async function confirmSampleProfile(t) {
  const { root, ws } = temporaryWorkspace(t);
  const sourcePath = join(root, 'sample-cv.txt');
  writeFileSync(sourcePath, SAMPLE_CV, 'utf8');
  const source = await importSource(ws, sourcePath);
  const proposed = proposeProfile(ws, {
    name: 'Example Candidate',
    facts: [
      {
        category: 'project',
        statement: 'Completed a simulated support-ticket exercise.',
        sourceId: source.id,
        excerpt: 'Completed a simulated customer-support exercise organizing 12 sample tickets by issue type.',
      },
      {
        category: 'skill',
        statement: 'Used a spreadsheet to summarize ticket categories.',
        sourceId: source.id,
        excerpt: 'Used a spreadsheet to summarize the ticket categories for the exercise.',
      },
    ],
    openQuestions: ['No employment dates were provided in this synthetic example.'],
  });
  assert.equal(proposed.facts.every(fact => fact.confirmed === false), true);
  const profileApproval = ws.store.list('approvals').find(item => item.action === 'profile' && item.entityId === proposed.id);
  assert.ok(profileApproval);
  decideApproval(ws,profileApproval.id,true,proposed.facts.map(fact=>fact.id));
  return { root, ws, source, profile: ws.store.require('profiles', proposed.id) };
}

function validMaterialInput(vacancyId, profile) {
  return {
    vacancyId,
    language: 'en',
    title: 'Support Analyst',
    claims: [
      {
        section: 'Practice Project',
        text: 'Completed a simulated customer-support exercise organizing 12 sample tickets by issue type.',
        factRefs: [{ factId: profile.facts[0].id, quote: 'Completed a simulated customer-support exercise organizing 12 sample tickets by issue type.' }],
      },
      {
        section: 'Skills',
        text: 'Used a spreadsheet to summarize ticket categories for a practice exercise.',
        factRefs: [{ factId: profile.facts[1].id, quote: 'Used a spreadsheet to summarize the ticket categories for the exercise.' }],
      },
    ],
    letter: {
      greeting: 'Dear Hiring Manager,',
      paragraphs: [
        {
          text: 'My practice project included organizing support requests and summarizing their categories.',
          factRefs: [{ factId: profile.facts[0].id, quote: 'Completed a simulated customer-support exercise organizing 12 sample tickets by issue type.' }],
        },
      ],
      closing: 'Sincerely,',
    },
  };
}

test('imports selectable PDF text and refuses unsupported or unreadable input', async t => {
  const { root, ws } = temporaryWorkspace(t);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Example Candidate — synthetic CV source', { x: 50, y: 750, size: 12, font });
  const pdfPath = join(root, 'sample.pdf');
  writeFileSync(pdfPath, await pdf.save());
  const imported = await importSource(ws, pdfPath);
  assert.match(imported.text, /Example Candidate/u);
  assert.equal(imported.hash.length, 64);
  assert.match(imported.path, /^sources\//u);

  const badPath = join(root, 'sample.csv');
  writeFileSync(badPath, 'not an accepted format', 'utf8');
  await assert.rejects(importSource(ws, badPath), /Unsupported source type/u);

  const imageOnlyPath = join(root, 'empty.pdf');
  const blankPdf = await PDFDocument.create();
  blankPdf.addPage();
  writeFileSync(imageOnlyPath, await blankPdf.save());
  await assert.rejects(importSource(ws, imageOnlyPath), /no selectable text.*OCR is not available/iu);
});

test('profile facts stay unconfirmed until local approval and quotes must be verbatim', async t => {
  const { root, ws } = temporaryWorkspace(t);
  const sourcePath = join(root, 'sample-cv.txt');
  writeFileSync(sourcePath, SAMPLE_CV, 'utf8');
  const source = await importSource(ws, sourcePath);
  assert.throws(() => proposeProfile(ws, {
    name: 'Example Candidate',
    facts: [{ category: 'skill', statement: 'A claim', sourceId: source.id, excerpt: 'This quote does not exist.' }],
  }), /not an exact excerpt/u);

  const proposed = proposeProfile(ws, {
    name: 'Example Candidate',
    facts: [{ category: 'project', statement: 'Completed a simulated exercise.', sourceId: source.id, excerpt: 'Completed a simulated customer-support exercise organizing 12 sample tickets by issue type.' }],
    openQuestions: ['No employment dates were provided.'],
  });
  assert.equal(proposed.facts[0].confirmed, false);
  assert.deepEqual(getContext(ws).facts, []);
  const approval = ws.store.list('approvals').find(item => item.action === 'profile' && item.entityId === proposed.id);
  assert.ok(approval);
  decideApproval(ws,approval.id,true,[proposed.facts[0].id]);
  assert.equal(ws.settings().profileId, proposed.id);
  assert.equal(ws.store.require('profiles', proposed.id).facts[0].confirmed, true);
  refreshContext(ws);
  assert.equal(JSON.parse(ws.read('context/current.json').toString('utf8')).profileId, proposed.id);
  assert.equal(getContext(ws).facts.length, 1);
  assert.match(getContext(ws).gaps.join('\n'), /No employment dates were provided/u);
});

test('vacancy IDs stay unique and duplicates never overwrite existing notes', async t => {
  const { ws } = temporaryWorkspace(t);
  await assert.rejects(captureVacancy(ws, { company: 'Example Organization', role: 'Support Analyst' }), /Provide pasted vacancy text or a user-provided URL/u);
  await assert.rejects(captureVacancy(ws, {
    company: 'Example Organization', role: 'Support Analyst', url: 'http://127.0.0.1/private',
  }), /public HTTPS on port 443/u);
  await assert.rejects(captureVacancy(ws, {
    company: 'Example Organization', role: 'Support Analyst', url: 'https://127.0.0.1/private',
  }), /safe public IPv4 address/i);
  const first = await captureVacancy(ws, {
    company: 'Example Organization', role: 'Support Analyst', text: 'Synthetic opening.',
    url: 'https://example.invalid/jobs/1?b=2&a=1', portalId: 'example-1', notes: 'Keep this note.',
  });
  await assert.rejects(captureVacancy(ws, {
    company: 'Different Company', role: 'Different Role', text: 'Changed portal content.',
    url: 'https://example.invalid/jobs/2', portalId: 'example-1', notes: 'Replacement note.',
  }), /existing record .* was left unchanged/u);
  await assert.rejects(captureVacancy(ws, {
    company: 'Example Organization', role: 'Support Analyst',
    url: 'https://example.invalid/jobs/1?a=1&b=2', portalId: 'example-2', notes: 'Do not replace the prior note.',
  }), /existing record .* was left unchanged/u);
  assert.equal(ws.store.require('vacancies', first.id).company, 'Example Organization');
  assert.equal(ws.store.require('vacancies', first.id).notes, 'Keep this note.');

  const possibleDuplicate = await captureVacancy(ws, {
    company: 'Example Organization', role: 'Support Analyst', text: 'Another synthetic opening.',
    url: 'https://example.invalid/jobs/3', portalId: 'example-3',
  });
  assert.deepEqual(possibleDuplicate.possibleDuplicates, [first.id]);
});

test('material output is evidence-bound, immutable across revisions, and exports exact approved bytes', async t => {
  const { ws, profile, source } = await confirmSampleProfile(t);
  const vacancy = await captureVacancy(ws, {
    company: 'Example Organization', role: 'Support Analyst', text: 'Synthetic role requiring clear support summaries.',
    url: 'https://example.invalid/jobs/support-analyst', portalId: 'example-support-analyst',
  });
  const draftInput = validMaterialInput(vacancy.id, profile);
  await assert.rejects(createMaterial(ws, {
    ...draftInput,
    claims: [{ section: 'Skills', text: 'Unverified claim.', factRefs: [{ factId: 'not-a-fact', quote: 'Not supported.' }] }],
  }), /not part of the current confirmed profile/u);
  const languageFlag = await createMaterial(ws, {
    ...draftInput,
    claims: [{ section: 'Pengalaman', text: 'saya berpengalaman dalam layanan pelanggan.', factRefs: [{ factId: profile.facts[0].id, quote: 'Completed a simulated customer-support exercise organizing 12 sample tickets by issue type.' }] }],
  });
  assert.match(languageFlag.languageWarning, /saya/u);
  const indonesianLetter = await createMaterial(ws, {
    ...draftInput,
    letter: { ...draftInput.letter, language: 'id', paragraphs: [{ text: 'Saya ingin melamar posisi ini.', factRefs: [{ factId: profile.facts[0].id, quote: 'Completed a simulated customer-support exercise organizing 12 sample tickets by issue type.' }] }] },
  });
  assert.equal(indonesianLetter.language, 'en');
  assert.equal(indonesianLetter.letterLanguage, 'id');
  assert.equal(indonesianLetter.languageWarning, undefined);
  assert.equal(JSON.parse(ws.read(indonesianLetter.files.evidence).toString('utf8')).language.letter, 'id');

  const material = await createMaterial(ws, draftInput);
  assert.equal(material.editingMode,'chat');
  assert.equal(material.resumeFormat,'bullet');
  assert.equal(material.files.docx,undefined);
  assert.match(ws.read(material.files.html).toString('utf8'),/<ul class="resume-bullets">/u);
  assert.deepEqual(Object.keys(material.fileHashes).sort(), Object.values(material.files).sort());
  assert.equal(material.manifestHash.length, 64);
  assert.equal(verifyMaterial(ws, material.id).manifestHash, material.manifestHash);
  assert.equal(JSON.parse(ws.read(material.files.evidence).toString('utf8')).language.fullNaturalLanguageDetection, false);
  assert.match(ws.read(material.files.pdf).subarray(0, 5).toString('ascii'), /^%PDF-/u);
  assert.equal(ws.store.require('attempts', material.attemptId).materialId, material.id);
  await assert.rejects(exportMaterial(ws, material.id, 'exports/unapproved'), /not been approved/u);

  const contentApproval = ws.store.list('approvals').find(item => item.action === 'content' && item.entityId === material.id);
  assert.ok(contentApproval);
  decideApproval(ws, contentApproval.id, true);
  const blockedWorktree = join(ws.root, 'blocked-worktree');
  mkdirSync(blockedWorktree);
  writeFileSync(join(blockedWorktree, '.git'), 'synthetic test marker');
  await assert.rejects(exportMaterial(ws, material.id, join(blockedWorktree, 'exports')), /outside Git worktrees/u);
  const exportResult = await exportMaterial(ws, material.id, 'exports/approved');
  assert.equal(exportResult.manifestHash, material.manifestHash);
  assert.deepEqual(readFileSync(exportResult.files.pdf), ws.read(material.files.pdf));
  assert.deepEqual(readFileSync(exportResult.files.html), ws.read(material.files.html));
  assert.deepEqual(readFileSync(exportResult.files.letter), ws.read(material.files.letter));
  assert.deepEqual(readFileSync(exportResult.files.evidence), ws.read(material.files.evidence));
  await assert.rejects(exportMaterial(ws, material.id, 'exports/approved'), /Refusing to overwrite/u);
  ws.write(material.files.html, '<!doctype html><html><body>tampered</body></html>');
  await assert.rejects(exportMaterial(ws, material.id, 'exports/tampered'), /changed after drafting|manifest has changed/u);

  const revision = await createMaterial(ws, { ...draftInput, attemptId: material.attemptId });
  assert.notEqual(revision.id, material.id);
  assert.equal(revision.attemptId, material.attemptId);
  assert.equal(ws.store.require('attempts', material.attemptId).materialId, revision.id);
  assert.equal(existsSync(ws.path(material.files.pdf)), true);
  assert.throws(() => verifyMaterial(ws, material.id), /current application revision has changed/u);

  const revisionApproval = ws.store.list('approvals').find(item => item.action === 'content' && item.entityId === revision.id);
  assert.ok(revisionApproval);
  decideApproval(ws, revisionApproval.id, true);
  const currentAttempt = ws.store.require('attempts', revision.attemptId);
  for (const status of ['interview', 'submitting', 'submission_uncertain']) {
    currentAttempt.status = status;
    ws.store.put('attempts', currentAttempt);
    await assert.rejects(createMaterial(ws, { ...draftInput, attemptId: revision.attemptId }), /already been reported or submitted/u);
  }
  const reapplication = await createMaterial(ws, draftInput);
  assert.notEqual(reapplication.attemptId, revision.attemptId);
  assert.notEqual(reapplication.id, revision.id);

  ws.write(source.path, Buffer.from(`${SAMPLE_CV}Updated source revision.`, 'utf8'));
  await assert.rejects(exportMaterial(ws, revision.id, 'exports/stale-source'), /Imported source changed after capture/u);

  const replacementPath = join(ws.root, 'updated-cv.txt');
  writeFileSync(replacementPath, 'SYNTHETIC EXAMPLE ONLY\nPractice materials were reorganized for the synthetic update.\n', 'utf8');
  const replacementSource = await importSource(ws, replacementPath);
  const replacementProfile = proposeProfile(ws, {
    name: 'Example Candidate',
    facts: [{
      category: 'project',
      statement: 'Practice materials were reorganized.',
      sourceId: replacementSource.id,
      excerpt: 'Practice materials were reorganized for the synthetic update.',
    }],
  });
  const replacementApproval = ws.store.list('approvals').find(item => item.action === 'profile' && item.entityId === replacementProfile.id);
  assert.ok(replacementApproval);
  decideApproval(ws,replacementApproval.id,true,[replacementProfile.facts[0].id]);
  assert.throws(() => verifyMaterial(ws, revision.id), /career profile has changed/u);
});
test('self-edit mode produces an editable DOCX and chat mode renders the saved Harvard layout', async t => {
  const { ws, profile } = await confirmSampleProfile(t);
  const vacancy = await captureVacancy(ws, {
    company: 'Example Organization', role: 'Support Analyst', text: 'Synthetic role requiring clear support summaries.',
    url: 'https://example.invalid/jobs/support-edit-mode', portalId: 'example-support-edit-mode',
  });
  const draftInput=validMaterialInput(vacancy.id,profile);
  const settings=ws.settings();settings.editingMode='self_edit';settings.resumeFormat='paragraph';ws.store.put('settings',settings);
  const editable=await createMaterial(ws,draftInput);
  assert.equal(editable.editingMode,'self_edit');
  assert.equal(editable.resumeFormat,'paragraph');
  assert.equal(typeof editable.files.docx,'string');
  const editableBytes=ws.read(editable.files.docx);
  assert.equal(editableBytes.subarray(0,2).toString('ascii'),'PK');
  const docxText=(await mammoth.extractRawText({buffer:editableBytes})).value;
  assert.match(docxText,/Example Candidate/u);
  assert.match(docxText,/Completed a simulated customer-support exercise/u);
  const paragraphHtml=ws.read(editable.files.html).toString('utf8');
  assert.match(paragraphHtml,/<p class="claim">/u);
  assert.doesNotMatch(paragraphHtml,/<ul class="resume-bullets">/u);

  settings.editingMode='chat';settings.resumeFormat='bullet';ws.store.put('settings',settings);
  const chat=await createMaterial(ws,{...draftInput,attemptId:editable.attemptId});
  assert.equal(chat.editingMode,'chat');
  assert.equal(chat.resumeFormat,'bullet');
  assert.equal(chat.files.docx,undefined);
  assert.match(ws.read(chat.files.html).toString('utf8'),/<ul class="resume-bullets">/u);
});
