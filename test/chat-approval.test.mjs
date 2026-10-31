import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { importSource } from '../dist/documents.js';
import { proposeProfile } from '../dist/profile.js';
import { initWorkspace } from '../dist/workspace.js';

const rootDir=resolve(fileURLToPath(new URL('..',import.meta.url)));
const cli=join(rootDir,'dist','cli.js');

function run(workspace,...args) {
  const result=spawnSync(process.execPath,[cli,...args,'--workspace',workspace],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},timeout:30_000});
  if(result.status!==0)throw new Error(`${args[0]} failed: ${result.stderr||result.error?.message}`);
  return JSON.parse(result.stdout);
}

async function createProposal(t) {
  const parent=mkdtempSync(join(tmpdir(),'jose-chat-approval-'));
  const workspace=join(parent,'private');
  const ws=initWorkspace(workspace,'id');
  const notes=join(workspace,'sources','intake.txt');
  writeFileSync(notes,"User said: I organized a sample project and built a prototype.\nUser said: I also documented the team's process.\n");
  const source=await importSource(ws,notes);
  const profile=proposeProfile(ws,{name:'Sample Person',facts:[
    {category:'project',statement:'Organized a sample project and built a prototype.',sourceId:source.id,excerpt:'User said: I organized a sample project and built a prototype.'},
    {category:'process',statement:'Documented the team process.',sourceId:source.id,excerpt:"User said: I also documented the team's process."},
  ],preferences:{},openQuestions:['Ask which role the user wants.']});
  ws.close();
  t.after(()=>{
    if(existsSync(join(workspace,'.jose-runtime','controller.json'))){try{run(workspace,'stop');}catch{/* controller may have already stopped */}}
    rmSync(parent,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  return {parent,workspace,profile};
}

function inputFile(parent,name,value) {
  const path=join(parent,`${name}.json`);writeFileSync(path,JSON.stringify(value));return path;
}

test('a chat approval returns the exact proposed facts and persists only the IDs the user chose',async t=>{
  const {parent,workspace,profile}=await createProposal(t);
  const pending=run(workspace,'review','--kind','profile','--id',profile.id).result;
  assert.equal(pending.approvalRequired,true);
  assert.equal(pending.action,'profile');
  assert.equal(pending.reviewUrl,undefined);
  assert.equal(existsSync(join(workspace,'.jose-runtime','controller.json')),false);
  assert.deepEqual(pending.summary.facts.map(fact=>fact.factId),profile.facts.map(fact=>fact.id));
  assert.equal(pending.summary.facts[0].quote,profile.facts[0].excerpt);

  const decision=run(workspace,'approval-decide','--input',inputFile(parent,'decision',{requestId:pending.requestId,decision:'approve',selectedFactIds:[profile.facts[0].id]})).result;
  assert.equal(decision.state,'approved');
  const context=run(workspace,'context').result;
  assert.deepEqual(context.facts.map(fact=>fact.id),[profile.facts[0].id]);
  assert.deepEqual(context.openQuestions,['Ask which role the user wants.']);
});

test('a chat approval cannot silently confirm every fact when the user selected none',async t=>{
  const {parent,workspace,profile}=await createProposal(t);
  const pending=run(workspace,'review','--kind','profile','--id',profile.id).result;
  const result=spawnSync(process.execPath,[cli,'approval-decide','--input',inputFile(parent,'decision',{requestId:pending.requestId,decision:'approve'}),'--workspace',workspace],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},timeout:30_000});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/explicit|select/i);
  const context=run(workspace,'context').result;
  assert.equal(context.profileId,null);
  assert.deepEqual(context.facts,[]);
});
