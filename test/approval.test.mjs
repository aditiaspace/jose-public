import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../dist/workspace.js';
import { bindingFor, requestApproval, authorize, ApprovalNeeded, decideApproval, consumeSubmission } from '../dist/approval.js';
import { hash, stable } from '../dist/util.js';

function setup(t) {
  const parent=mkdtempSync(join(tmpdir(),'jose-approval-'));const ws=initWorkspace(join(parent,'private'),'en','opencode');
  t.after(()=>{ws.close();rmSync(parent,{recursive:true,force:true});});
  const profile={id:'profile-one',name:'Sample Person',facts:[{id:'fact-one',category:'project',statement:'Built a prototype',sourceId:'source-one',excerpt:'Built a prototype',confirmed:false}],preferences:{},openQuestions:[],createdAt:'2026-01-01T00:00:00.000Z'};
  ws.store.create('profiles',profile);
  return {ws,profile};
}
function material(ws) {
  const m={id:'material-one',attemptId:'attempt-one',vacancyId:'vacancy-one',profileId:'profile-one',language:'en',createdAt:'2026-01-01T00:00:00.000Z',title:'Sample role',files:{html:'applications/attempt-one/cv.html',pdf:'applications/attempt-one/cv.pdf',letter:'applications/attempt-one/letter.md',evidence:'applications/attempt-one/evidence.json'},fileHashes:{},manifestHash:''};
  for(const [kind,path] of Object.entries(m.files)){const bytes=kind==='pdf'?Buffer.from('%PDF-neutral-fixture'):Buffer.from(kind);ws.write(path,bytes);m.fileHashes[path]=hash(bytes);}
  m.manifestHash=hash(stable({materialId:m.id,attemptId:m.attemptId,vacancyId:m.vacancyId,profileId:m.profileId,language:m.language,files:m.files,fileHashes:m.fileHashes}));
  ws.store.create('attempts',{id:'attempt-one',vacancyId:'vacancy-one',materialId:m.id,status:'draft',createdAt:m.createdAt});ws.store.create('materials',m);return m;
}

test('content approval is bound to a confirmed profile and exact artifact bytes',t=>{
  const {ws,profile}=setup(t);
  const profileRequest=requestApproval(ws,'profile',profile.id,bindingFor(ws,'profile',profile.id),{name:profile.name});
  assert.throws(()=>authorize(ws,'profile',profile.id,profileRequest.binding,{}),ApprovalNeeded);
  decideApproval(ws,profileRequest.id,true);
  const m=material(ws);const binding=bindingFor(ws,'content',m.id);
  assert.throws(()=>authorize(ws,'content',m.id,binding,{},false,m.attemptId),ApprovalNeeded);
  const pending=ws.store.list('approvals').find(a=>a.action==='content');decideApproval(ws,pending.id,true);
  assert.equal(authorize(ws,'content',m.id,binding,{},false,m.attemptId).state,'approved');
  ws.write(m.files.letter,'different letter');
  assert.throws(()=>bindingFor(ws,'content',m.id),/changed/i);
});

test('rejection and stale profile proposal cannot produce an approval',t=>{
  const {ws,profile}=setup(t);const binding=bindingFor(ws,'profile',profile.id);
  const request=requestApproval(ws,'profile',profile.id,binding,{});decideApproval(ws,request.id,false);
  assert.throws(()=>authorize(ws,'profile',profile.id,binding,{}),ApprovalNeeded);
  const pending=ws.store.list('approvals').find(a=>a.state==='pending');profile.name='Changed Person';ws.store.put('profiles',profile);
  assert.throws(()=>decideApproval(ws,pending.id,true),/changed/i);
  assert.equal(ws.settings().onboarding,'not_started');
});

test('submit permission cannot be replayed or reused for another target',t=>{
  const {ws}=setup(t);const req=requestApproval(ws,'submit','vacancy-one','binding-one',{role:'Sample'});
  decideApproval(ws,req.id,true);
  assert.equal(authorize(ws,'submit','vacancy-one','binding-one',{},true).state,'consumed');
  assert.throws(()=>authorize(ws,'submit','vacancy-one','binding-one',{},true),ApprovalNeeded);
  assert.throws(()=>authorize(ws,'submit','vacancy-two','binding-one',{},true),ApprovalNeeded);
});

test('a send approval and submitting state are consumed atomically',t=>{
  const {ws,profile}=setup(t);const profileRequest=requestApproval(ws,'profile',profile.id,bindingFor(ws,'profile',profile.id),{});decideApproval(ws,profileRequest.id,true);
  const m=material(ws);const content=requestApproval(ws,'content',m.id,bindingFor(ws,'content',m.id),{},m.attemptId);decideApproval(ws,content.id,true);
  const send=requestApproval(ws,'submit',m.id,'exact-form',{},m.attemptId);decideApproval(ws,send.id,true);
  consumeSubmission(ws,m.id,'exact-form',{},m.attemptId);
  assert.equal(ws.store.require('attempts',m.attemptId).status,'submitting');
  assert.equal(ws.store.require('approvals',send.id).state,'consumed');
  assert.throws(()=>consumeSubmission(ws,m.id,'exact-form',{},m.attemptId),/already submitted|uncertain/i);
});

test('profile review confirms only individually selected facts',t=>{
  const {ws,profile}=setup(t);
  profile.facts.push({id:'fact-two',category:'employment',statement:'Held an additional role',sourceId:'source-two',excerpt:'Held an additional role',confirmed:false});
  ws.store.put('profiles',profile);
  const request=requestApproval(ws,'profile',profile.id,bindingFor(ws,'profile',profile.id),{});
  decideApproval(ws,request.id,true,['fact-one']);
  const saved=ws.store.require('profiles',profile.id);
  assert.equal(saved.facts.find(fact=>fact.id==='fact-one').confirmed,true);
  assert.equal(saved.facts.find(fact=>fact.id==='fact-two').confirmed,false);
  assert.equal(ws.settings().onboarding,'ready');
});
