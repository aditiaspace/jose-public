import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { initWorkspace, Workspace } from '../dist/workspace.js';
import { hash } from '../dist/util.js';

const cli=resolve('dist/cli.js');
function run(root,...args) {
  const r=spawnSync(process.execPath,[cli,...args,'--workspace',root],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},timeout:25_000});
  if(r.status!==0)throw new Error(`CLI failed: ${r.stderr||r.error?.message}`);
  return JSON.parse(r.stdout);
}

test('review page requires same-origin session and a one-time decision',async t=>{
  const base=mkdtempSync(join(tmpdir(),'jose-review-'));const root=join(base,'workspace');
  const ws=initWorkspace(root,'id');
  ws.write('sources/s1.txt','Built a prototype');
  ws.store.create('sources',{id:'s1',name:'sample.txt',path:'sources/s1.txt',text:'Built a prototype',hash:hash('Built a prototype'),warnings:[],createdAt:'2026-01-01'});
  ws.store.create('profiles',{id:'candidate',name:'Sample Person',facts:[{id:'f1',category:'project',statement:'Built a prototype',sourceId:'s1',excerpt:'Built a prototype',confirmed:false}],preferences:{},openQuestions:[],createdAt:'2026-01-01'});
  const settings=ws.settings();settings.onboarding='awaiting_confirmation';ws.store.put('settings',settings);
  ws.close();
  let started=false;
  t.after(async()=>{if(started){try{run(root,'stop');}catch{}await new Promise(resolveWait=>setTimeout(resolveWait,300));}rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const result=run(root,'review','--kind','profile','--id','candidate').result;started=true;
  const url=new URL(result.reviewUrl);const page=await fetch(url);assert.equal(page.status,200);
  const html=await page.text();assert.match(html,/Sample Person/);assert.match(html,/Tinjau sebelum melanjutkan/);assert.match(html,/name="factId" value="f1"/u);assert.doesNotMatch(html,/name="factId" value="f1" checked/u);
  const cookie=page.headers.get('set-cookie').split(';')[0];const csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const path=url.pathname.replace('/review/','/decision/');
  const form=new URLSearchParams({csrf,decision:'approve',factId:'f1'});
  const blocked=await fetch(url.origin+path,{method:'POST',headers:{Cookie:cookie,Origin:'https://untrusted.example','Content-Type':'application/x-www-form-urlencoded'},body:form});assert.equal(blocked.status,403);
  const missingCsrf=await fetch(url.origin+path,{method:'POST',headers:{Cookie:cookie,Origin:url.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:'wrong',decision:'approve'})});assert.equal(missingCsrf.status,403);
  const noFacts=await fetch(url.origin+path,{method:'POST',headers:{Cookie:cookie,Origin:'null','Sec-Fetch-Site':'none','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,decision:'approve'})});
  assert.equal(noFacts.status,400);
  const stillPending=new Workspace(root);try{assert.equal(stillPending.settings().onboarding,'awaiting_confirmation');}finally{stillPending.close();}
  const approved=await fetch(url.origin+path,{method:'POST',headers:{Cookie:cookie,Origin:'null','Sec-Fetch-Site':'none','Content-Type':'application/x-www-form-urlencoded'},body:form});assert.equal(approved.status,200);
  const again=await fetch(url);assert.equal(again.status,410);
  const reopened=new Workspace(root);try{assert.equal(reopened.settings().onboarding,'ready');assert.equal(reopened.settings().profileId,'candidate');assert.equal(reopened.store.require('profiles','candidate').facts[0].confirmed,true);}finally{reopened.close();}
});
