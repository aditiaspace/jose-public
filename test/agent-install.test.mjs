import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const cli=join(root,'dist','cli.js');
function containsBytes(directory,needle) {
  return readdirSync(directory,{withFileTypes:true}).some(entry=>{
    const path=join(directory,entry.name);
    return entry.isDirectory()?containsBytes(path,needle):readFileSync(path).includes(Buffer.from(needle));
  });
}

function run(workspace,operation,extra=[],env={}) {
  const result=spawnSync(process.execPath,[cli,operation,'--workspace','.',...extra],{
    cwd:workspace,
    encoding:'utf8',
    env:{...process.env,...env},
    timeout:30_000,
  });
  if(result.status!==0)throw new Error(`${operation} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('Jose installs in the active private folder without choosing a client or storing its credentials',t=>{
  const workspace=mkdtempSync(join(tmpdir(),'jose-agent-workspace-'));
  t.after(()=>rmSync(workspace,{recursive:true,force:true}));
  const marker='host-credential-must-not-be-copied-into-jose';

  const initialized=run(workspace,'init',['--language','id'],{
    ANTHROPIC_API_KEY:marker,
    DEEPSEEK_API_KEY:marker,
    OPENCODE_AUTH_CONTENT:marker,
  });
  assert.equal(initialized.ok,true);
  assert.equal(initialized.workspace,workspace);
  assert.equal(initialized.language,'id');
  assert.equal(Object.hasOwn(initialized,'client'),false);
  assert.equal(existsSync(join(workspace,'client-config')),false);
  assert.equal(existsSync(join(workspace,'.agents','skills','jose','SKILL.md')),true);
  assert.equal(existsSync(join(workspace,'.claude','skills','jose','SKILL.md')),true);
  assert.equal(existsSync(join(workspace,'AGENTS.md')),true);
  assert.equal(existsSync(join(workspace,'CLAUDE.md')),true);
  const ignore=readFileSync(join(workspace,'.gitignore'),'utf8');
  for(const path of ['.jose/','state/','sources/','applications/','browser/','client-config/'])assert.ok(ignore.includes(path));

  const doctor=run(workspace,'doctor',[],{
    PATH:'',
    ANTHROPIC_API_KEY:marker,
    DEEPSEEK_API_KEY:marker,
    OPENCODE_AUTH_CONTENT:marker,
  });
  assert.equal(doctor.ok,true);
  assert.equal(doctor.result.workspace,workspace);
  assert.equal(doctor.result.language,'id');
  assert.equal(Object.hasOwn(doctor.result,'client'),false);
  assert.equal(JSON.stringify(doctor).includes(marker),false);
  assert.equal(doctor.result.hostCredentialsInspected,false);
  assert.equal(doctor.result.workspaceInstructionsReady,true);
  assert.equal(containsBytes(workspace,marker),false);
  assert.equal(readFileSync(join(workspace,'.jose-workspace'),'utf8'),'1\n');
});
