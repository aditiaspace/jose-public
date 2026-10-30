import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INSTALL_ROOT, type Workspace } from './workspace.js';

const AGENTS_START='<!-- JOSE:BEGIN -->';
const AGENTS_END='<!-- JOSE:END -->';
const CLAUDE_START='<!-- JOSE:CLAUDE:BEGIN -->';
const CLAUDE_END='<!-- JOSE:CLAUDE:END -->';
const GITIGNORE_START='# JOSE:PRIVATE:BEGIN';
const GITIGNORE_END='# JOSE:PRIVATE:END';

function asset(relative:string):string {
  return readFileSync(resolve(INSTALL_ROOT,relative),'utf8');
}

function ensureExactFile(ws:Workspace,relative:string,content:string):void {
  const path=ws.path(relative);
  if(existsSync(path)) {
    if(readFileSync(path,'utf8')===content)return;
    throw new Error(`Refusing to overwrite existing workspace file ${relative}; move or review it before installing Jose.`);
  }
  ws.write(relative,content);
}

function replaceManagedBlock(ws:Workspace,relative:string,start:string,end:string,block:string):void {
  const path=ws.path(relative);
  const existing=existsSync(path)?readFileSync(path,'utf8'):'';
  const startAt=existing.indexOf(start);
  const endAt=existing.indexOf(end);
  if(startAt===-1&&endAt===-1) {
    const next=existing?`${existing}${existing.endsWith('\n')?'\n':'\n\n'}${block}\n`:`${block}\n`;
    ws.write(relative,next);
    return;
  }
  if(startAt===-1||endAt<startAt||existing.indexOf(start,startAt+start.length)!==-1||existing.indexOf(end,endAt+end.length)!==-1) {
    throw new Error(`${relative} contains incomplete or repeated Jose markers; it was left unchanged.`);
  }
  const next=`${existing.slice(0,startAt)}${block}${existing.slice(endAt+end.length)}`;
  if(next!==existing)ws.write(relative,next);
}

function agentsBlock():string {
  return `${AGENTS_START}
## Jose private workspace

Use the Jose skill in \`.agents/skills/jose/SKILL.md\` for job-search work; Claude Code also has the equivalent under \`.claude/skills/jose/SKILL.md\`. Read \`instructions/jose.md\` before acting. At the beginning of every session, read \`context/current.json\` if it exists and run \`node .jose/node_modules/jose-workspace/dist/cli.js context --workspace .\` from this workspace root.

Use the active harness's existing LLM and credentials. Never request, inspect, copy, or change host credentials or global client settings. Use only the Jose CLI for workspace state. Before personal text is sent to a hosted model, explain the provider data handling and obtain consent. Keep CV/resume artifacts in English, use only confirmed source-backed facts, and follow Jose's exact review/disclosure/submit gates.
${AGENTS_END}`;
}

function claudeBlock():string {
  return `${CLAUDE_START}
For Jose job-search work in this folder, invoke the \`jose\` skill and follow \`instructions/jose.md\`. Use the active Claude Code model and its existing credentials; never ask for or change credentials. Keep Jose data in this folder and require the local review page for facts, materials, disclosure, and final submission.
${CLAUDE_END}`;
}

function ignoreBlock():string {
  return `${GITIGNORE_START}
.jose/
.jose-workspace
state/
sources/
context/
applications/
browser/
.jose-runtime/
client-config/
.env
.env.*
!.env.example
${GITIGNORE_END}`;
}

export function configureWorkspace(ws:Workspace):void {
  ensureExactFile(ws,'instructions/jose.md',asset('instructions/neutral.md'));
  ensureExactFile(ws,'prompts/setup.en.md',asset('prompts/setup.en.md'));
  ensureExactFile(ws,'prompts/setup.id.md',asset('prompts/setup.id.md'));
  ensureExactFile(ws,'guides/SETUP.md',asset('SETUP.md'));
  ensureExactFile(ws,'guides/SETUP.id.md',asset('SETUP.id.md'));
  const skill=asset('skills/jose/SKILL.md');
  ensureExactFile(ws,'.agents/skills/jose/SKILL.md',skill);
  ensureExactFile(ws,'.claude/skills/jose/SKILL.md',skill);
  replaceManagedBlock(ws,'AGENTS.md',AGENTS_START,AGENTS_END,agentsBlock());
  replaceManagedBlock(ws,'CLAUDE.md',CLAUDE_START,CLAUDE_END,claudeBlock());
  replaceManagedBlock(ws,'.gitignore',GITIGNORE_START,GITIGNORE_END,ignoreBlock());
}

export function workspaceDoctor(ws:Workspace):Record<string,unknown> {
  const node=process.versions.node;
  const nodeVersion=/^(\d+)\.(\d+)\.(\d+)/.exec(node);
  const nodeCompatible=!!nodeVersion&&Number(nodeVersion[1])===24&&Number(nodeVersion[2])>=15;
  const requiredFiles=['instructions/jose.md','prompts/setup.en.md','prompts/setup.id.md','guides/SETUP.md','guides/SETUP.id.md','.agents/skills/jose/SKILL.md','.claude/skills/jose/SKILL.md'];
  const missingFiles=requiredFiles.filter(relative=>!existsSync(ws.path(relative)));
  const hasAgents=existsSync(ws.path('AGENTS.md'))&&readFileSync(ws.path('AGENTS.md'),'utf8').includes(AGENTS_START)&&readFileSync(ws.path('AGENTS.md'),'utf8').includes(AGENTS_END);
  const hasClaude=existsSync(ws.path('CLAUDE.md'))&&readFileSync(ws.path('CLAUDE.md'),'utf8').includes(CLAUDE_START)&&readFileSync(ws.path('CLAUDE.md'),'utf8').includes(CLAUDE_END);
  const hasIgnore=existsSync(ws.path('.gitignore'))&&readFileSync(ws.path('.gitignore'),'utf8').includes(GITIGNORE_START)&&readFileSync(ws.path('.gitignore'),'utf8').includes(GITIGNORE_END);
  const issues:string[]=[];
  if(!nodeCompatible)issues.push(`Node.js 24.15 or newer in the 24.x line is required; this CLI is running on ${node}.`);
  if(missingFiles.length)issues.push(`Jose workspace support files are missing: ${missingFiles.join(', ')}. Run node .jose/node_modules/jose-workspace/dist/cli.js init --workspace . --language ${ws.settings().language} from the workspace root after resolving any file conflicts.`);
  if(!hasAgents||!hasClaude||!hasIgnore)issues.push(`Jose workspace instructions or private-file ignore rules are incomplete. Run node .jose/node_modules/jose-workspace/dist/cli.js init --workspace . --language ${ws.settings().language} from the workspace root after resolving any file conflicts.`);
  return {ok:issues.length===0,node,language:ws.settings().language,onboarding:ws.settings().onboarding,workspaceInstructionsReady:issues.length===0,hostCredentialsInspected:false,legacyClientConfigPresent:existsSync(ws.path('client-config')),issues};
}
