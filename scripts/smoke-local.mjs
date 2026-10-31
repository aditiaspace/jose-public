import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const temp=mkdtempSync(join(tmpdir(),'jose-neutral-smoke-'));
const workspace=join(temp,'workspace');
function run(operation,...flags) {
  const p=spawnSync(process.execPath,[join(root,'dist','cli.js'),operation,'--workspace',workspace,...flags],{cwd:root,encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},timeout:90_000});
  if(p.status!==0)throw new Error(`${operation} failed: ${p.stderr||p.error?.message||p.stdout}`);
  try{return JSON.parse(p.stdout);}catch{throw new Error(`${operation} did not return JSON: ${p.stdout}`);}
}
function input(name,value) {const file=join(temp,`${name}.json`);writeFileSync(file,JSON.stringify(value));return file;}
function chatApproval(result) {
  const pending=result?.result;
  if(!pending?.approvalRequired||typeof pending.requestId!=='string')throw new Error('Chat approval details were not returned.');
  const selectedFactIds=pending.action==='profile'?pending.summary.facts.map(fact=>fact.factId):undefined;
  const decision={requestId:pending.requestId,decision:'approve',...(selectedFactIds?{selectedFactIds}:{})};
  const saved=run('approval-decide','--input',input('approval',decision)).result;
  if(saved.state!=='approved')throw new Error('The chat approval was not persisted.');
}
try {
  const source=join(temp,'fictional-cv.txt');const sourceText='Sample Person\nEducation: Bachelor of Design\nProject: Built a prototype for a student project.';writeFileSync(source,sourceText);
  run('init','--language','id');
  run('workflow-preferences','--input',input('preferences',{editingMode:'chat',resumeFormat:'bullet'}));
  const imported=run('source-import','--file',source).result;
  const proposed=run('profile-propose','--input',input('profile',{name:'Sample Person',facts:[{category:'project',statement:'Built a prototype for a student project.',sourceId:imported.id,excerpt:'Built a prototype for a student project.'}],preferences:{},openQuestions:['Confirm dates']})).result;
  chatApproval(run('review','--kind','profile','--id',proposed.id));
  const context=run('context').result;
  const vacancy=run('vacancy-add','--input',input('vacancy',{company:'Example Workshop',role:'Junior Designer',text:'Looking for someone who can build prototypes.',notes:''})).result;
  const fact=proposed.facts[0];
  const draft=run('material-create','--input',input('draft',{vacancyId:vacancy.id,language:'en',title:'Junior Designer',claims:[{section:'Projects',text:'Built a prototype for a student project.',factRefs:[{factId:fact.id,quote:fact.statement}]}],letter:{paragraphs:[{text:'I built a prototype for a student project.',factRefs:[{factId:fact.id,quote:fact.statement}]}]}})).result;
  chatApproval(run('review','--kind','content','--id',draft.id));
  const output=join(temp,'exports');mkdirSync(output);run('material-export','--id',draft.id,'--out',output);
  run('application-report','--input',input('report',{materialId:draft.id,dateApplied:'2026-01-01',status:'applied',operationId:'neutral-smoke'}));
  const history=run('application-list').result;if(!Array.isArray(history)||!history.some(a=>a.materialId===draft.id&&a.status==='applied'))throw new Error('Reported application was not persisted.');
  const backup=join(temp,'backup.jose.gz');run('backup-export','--out',backup);
  const restored=join(temp,'restored');const restore=spawnSync(process.execPath,[join(root,'dist','cli.js'),'backup-restore','--workspace',restored,'--file',backup],{cwd:root,encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},timeout:90_000});
  if(restore.status!==0)throw new Error(`Restore failed: ${restore.stderr}`);
  console.log(JSON.stringify({ok:true,workspaceLanguage:'id',profileId:proposed.id,contextLoaded:!!context,vacancyId:vacancy.id,materialId:draft.id,reported:true,restored:true,note:'Fictional data and persisted chat approvals only; no model, Jobstreet, upload or submission was used.'},null,2));
}finally{
  rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
