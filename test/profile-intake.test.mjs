import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importSource } from '../dist/documents.js';
import { decideApproval } from '../dist/approval.js';
import { getContext, proposeProfile } from '../dist/profile.js';
import { initWorkspace } from '../dist/workspace.js';

test('a user without a CV can confirm profile facts from their own intake notes',async t=>{
  const root=mkdtempSync(join(tmpdir(),'jose-no-cv-intake-'));
  const ws=initWorkspace(join(root,'private'),'id');
  t.after(()=>{ws.close();rmSync(root,{recursive:true,force:true});});
  const notes=join(ws.root,'sources','conversation-notes.txt');
  const excerpt='User said: I organized a fictional class project and built a prototype.';
  writeFileSync(notes,`${excerpt}\n`);

  const source=await importSource(ws,notes);
  const proposal=proposeProfile(ws,{name:'Sample Person',facts:[{
    category:'project',statement:'Organized a class project and built a prototype.',sourceId:source.id,excerpt,
  }],preferences:{},openQuestions:['Ask which role the user wants to pursue.']});
  assert.equal(proposal.facts[0].confirmed,false);
  assert.equal(getContext(ws).profileId,null);

  const request=ws.store.list('approvals').find(item=>item.action==='profile');
  assert.ok(request);
  decideApproval(ws,request.id,true,[proposal.facts[0].id]);
  const context=getContext(ws);
  assert.equal(context.profileId,proposal.id);
  assert.equal(context.facts[0].quote,excerpt);
  assert.deepEqual(context.openQuestions,['Ask which role the user wants to pursue.']);
});
