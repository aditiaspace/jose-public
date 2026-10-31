import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initWorkspace } from '../dist/workspace.js';

const rootDir=resolve(fileURLToPath(new URL('..',import.meta.url)));
const cli=join(rootDir,'dist','cli.js');
function run(workspace,...args) {
  const result=spawnSync(process.execPath,[cli,...args,'--workspace',workspace],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},timeout:30_000});
  if(result.status!==0)throw new Error(`${args[0]} failed: ${result.stderr||result.error?.message}`);
  return JSON.parse(result.stdout);
}
function input(parent,name,value) {
  const path=join(parent,`${name}.json`);writeFileSync(path,JSON.stringify(value));return path;
}

test('editing mode and Harvard resume format are saved locally and can be changed on request',t=>{
  const parent=mkdtempSync(join(tmpdir(),'jose-workflow-preferences-'));
  const workspace=join(parent,'private');
  const ws=initWorkspace(workspace,'id');ws.close();
  t.after(()=>rmSync(parent,{recursive:true,force:true}));

  const first=run(workspace,'workflow-preferences','--input',input(parent,'first',{editingMode:'self_edit',resumeFormat:'bullet'})).result;
  assert.deepEqual(first,{editingMode:'self_edit',resumeFormat:'bullet'});
  assert.deepEqual(run(workspace,'context').result.workspace.workflowPreferences,{editingMode:'self_edit',resumeFormat:'bullet'});

  const changed=run(workspace,'workflow-preferences','--input',input(parent,'changed',{resumeFormat:'paragraph'})).result;
  assert.deepEqual(changed,{editingMode:'self_edit',resumeFormat:'paragraph'});
  assert.deepEqual(run(workspace,'context').result.workspace.workflowPreferences,{editingMode:'self_edit',resumeFormat:'paragraph'});
});
