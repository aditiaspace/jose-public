import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Document, HeadingLevel, Paragraph, Packer, TextRun } from 'docx';
import { decideApproval, verifyMaterial } from '../dist/approval.js';
import { extractPdfText, importSource } from '../dist/documents.js';
import { captureVacancy, createMaterial } from '../dist/materials.js';
import { proposeProfile } from '../dist/profile.js';
import { initWorkspace } from '../dist/workspace.js';
const rootDir=resolve(fileURLToPath(new URL('..',import.meta.url)));
const cli=join(rootDir,'dist','cli.js');

function runCli(ws,operation,args) {
  const result=spawnSync(process.execPath,[cli,operation,...args,'--workspace',ws.root],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},timeout:30_000});
  if(result.status!==0)throw new Error(`${operation} failed: ${result.stderr||result.error?.message}`);
  return JSON.parse(result.stdout);
}

test('edited self-edit DOCX is checked, preserved in a new revision, and explicitly re-approved', async t => {
  const root=mkdtempSync(join(tmpdir(),'jose-material-edit-'));
  const ws=initWorkspace(join(root,'private'),'en');
  t.after(()=>{ws.close();rmSync(root,{recursive:true,force:true});});
  const settings=ws.settings();settings.editingMode='self_edit';settings.resumeFormat='bullet';ws.store.put('settings',settings);
  const cv=join(ws.root,'sources','fictional-cv.txt');
  const excerpt='Fictional candidate organized a sample support project.';
  const editedText='Organized a sample support project.';
  writeFileSync(cv,`${excerpt}\n`);
  const source=await importSource(ws,cv);
  const profile=proposeProfile(ws,{name:'Fictional Candidate',facts:[{category:'project',statement:excerpt,sourceId:source.id,excerpt}],preferences:{},openQuestions:[]});
  decideApproval(ws,ws.store.list('approvals').find(item=>item.action==='profile').id,true,[profile.facts[0].id]);
  const vacancy=await captureVacancy(ws,{company:'Example Organization',role:'Support Assistant',text:'Synthetic test vacancy.'});
  const material=await createMaterial(ws,{vacancyId:vacancy.id,language:'en',title:'Support Assistant',claims:[{section:'Projects',text:excerpt,factRefs:[{factId:profile.facts[0].id,quote:excerpt}]}],letter:{paragraphs:[{text:excerpt,factRefs:[{factId:profile.facts[0].id,quote:excerpt}]}]}});
  assert.ok(material.files.docx);
  const revisedDocx=await Packer.toBuffer(new Document({sections:[{children:[
    new Paragraph('Fictional Candidate'),
    new Paragraph('Support Assistant'),
    new Paragraph({children:[new TextRun({text:'PROJECTS'})],heading:HeadingLevel.HEADING_1}),
    new Paragraph(editedText),
  ]}]}));
  ws.write(material.files.docx,revisedDocx);

  const inspection=runCli(ws,'material-edit-inspect',['--id',material.id]).result;
  assert.equal(inspection.changed,true);
  assert.equal(inspection.attemptId,material.attemptId);
  assert.equal(inspection.editedDocxFile,material.files.docx);
  assert.match(inspection.extractedText,/Organized a sample support project/u);
  assert.equal(inspection.previouslyApproved,false);
  assert.deepEqual(inspection.confirmedFacts.map(fact=>fact.id),[profile.facts[0].id]);
  assert.equal(ws.store.list('approvals').find(item=>item.action==='content'&&item.entityId===material.id).state,'pending');
  assert.throws(()=>verifyMaterial(ws,material.id),/Document changed after drafting/u);

  const revisionInputFile=join(ws.root,'state','material-revision.json');
  writeFileSync(revisionInputFile,JSON.stringify({
    vacancyId:vacancy.id,
    attemptId:inspection.attemptId,
    editedDocxFile:inspection.editedDocxFile,
    editedDocxHash:inspection.editedDocxHash,
    language:'en',
    title:'Support Assistant',
    claims:[{section:'Projects',text:editedText,factRefs:[{factId:profile.facts[0].id,quote:excerpt}]}],
    letter:{paragraphs:[{text:excerpt,factRefs:[{factId:profile.facts[0].id,quote:excerpt}]}]},
  }));
  const revisedMaterial=runCli(ws,'material-create',['--input',revisionInputFile]).result;
  assert.notEqual(revisedMaterial.id,material.id);
  assert.equal(revisedMaterial.attemptId,material.attemptId);
  assert.equal(revisedMaterial.approvedAt,undefined);
  assert.equal(ws.store.require('attempts',material.attemptId).materialId,revisedMaterial.id);
  assert.doesNotThrow(()=>verifyMaterial(ws,revisedMaterial.id));
  assert.equal(ws.store.list('approvals').find(item=>item.action==='content'&&item.entityId===revisedMaterial.id).state,'pending');

  const review=runCli(ws,'review',['--kind','content','--id',revisedMaterial.id]).result;
  assert.equal(review.approvalRequired,true);
  assert.match(review.summary.resumeText,/Organized a sample support project/u);
  assert.match(review.summary.pdfRenderingNote,/custom Word styling/u);
  assert.equal(review.summary.files.html,undefined);
  const decisionFile=join(ws.root,'state','approval.json');
  writeFileSync(decisionFile,JSON.stringify({requestId:review.requestId,decision:'approve'}));
  assert.equal(runCli(ws,'approval-decide',['--input',decisionFile]).result.state,'approved');

  const exported=runCli(ws,'material-export',['--id',revisedMaterial.id,'--out','exports']).result;
  assert.equal(readFileSync(exported.files.docx).equals(revisedDocx),true);
  assert.equal(exported.files.html,undefined);
  assert.match(await extractPdfText(readFileSync(exported.files.pdf)),/Organized a sample support project/u);
});
