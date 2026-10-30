import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkspace, Workspace } from '../dist/workspace.js';

test('each private workspace has isolated persistent state and reinitialization preserves it',t=>{
  const root=mkdtempSync(join(tmpdir(),'jose-workspaces-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const first=initWorkspace(join(root,'first'),'id');const firstId=first.settings().workspaceId;
  first.store.create('vacancies',{id:'first-only',company:'Example',role:'Designer',text:'Role',capturedAt:'2026-01-01',notes:'private note',possibleDuplicates:[]});first.close();
  const second=initWorkspace(join(root,'second'),'en');assert.notEqual(second.settings().workspaceId,firstId);assert.equal(second.store.get('vacancies','first-only'),null);second.close();
  const reopened=initWorkspace(join(root,'first'),'en');assert.equal(reopened.settings().workspaceId,firstId);assert.equal(reopened.settings().language,'id');assert.equal(reopened.store.get('vacancies','first-only').notes,'private note');reopened.close();
});

test('private workspace rejects git worktrees, traversal, and linked artifacts',t=>{
  const root=mkdtempSync(join(tmpdir(),'jose-boundaries-'));
  const publicRepo=join(root,'public');mkdirSync(join(publicRepo,'.git'),{recursive:true});
  assert.throws(()=>initWorkspace(join(publicRepo,'private'),'en'),/outside Git worktrees/i);
  const ws=initWorkspace(join(root,'private'),'en');t.after(()=>{ws.close();rmSync(root,{recursive:true,force:true});});
  assert.throws(()=>ws.write('../escape.txt','private'),/escapes/i);
  const target=join(root,'outside');mkdirSync(target);symlinkSync(target,join(ws.root,'sources','linked'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>ws.write('sources/linked/private.txt','private'),/symlink|outside/i);
});

test('a missing workspace database is an error instead of creating empty state',t=>{
  const root=mkdtempSync(join(tmpdir(),'jose-missing-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const ws=initWorkspace(join(root,'private'),'en');const path=ws.path('state/jose.sqlite');ws.close();rmSync(path);
  assert.throws(()=>new Workspace(join(root,'private')),/database is missing/i);
});
