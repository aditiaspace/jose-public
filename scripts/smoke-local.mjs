import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const temp=mkdtempSync(join(tmpdir(),'jose-neutral-smoke-'));
const workspace=join(temp,'workspace');
let controllerStarted=false;
function run(operation,...flags) {
  const p=spawnSync(process.execPath,[join(root,'dist','cli.js'),operation,'--workspace',workspace,...flags],{cwd:root,encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},timeout:90_000});
  if(p.status!==0)throw new Error(`${operation} failed: ${p.stderr||p.error?.message||p.stdout}`);
  try{return JSON.parse(p.stdout);}catch{throw new Error(`${operation} did not return JSON: ${p.stdout}`);}
}
function input(name,value) {const file=join(temp,`${name}.json`);writeFileSync(file,JSON.stringify(value));return file;}
async function neutralApproval(result) {
  const url=result?.result?.reviewUrl;if(typeof url!=='string')throw new Error('The review page was not returned.');
  controllerStarted=true;
  const response=await fetch(url);if(!response.ok)throw new Error(`Review page returned ${response.status}`);
  const cookie=response.headers.get('set-cookie')?.split(';')[0];const html=await response.text();
  const csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  if(!cookie||!csrf)throw new Error('Review form is missing its local session or CSRF token.');
  const address=new URL(url);const decision=address.pathname.replace('/review/','/decision/');
  const body=new URLSearchParams({csrf,decision:'approve',english:'yes'});
  for(const match of html.matchAll(/name="factId" value="([^"]+)"/g))body.append('factId',match[1]);
  const sent=await fetch(`${address.origin}${decision}`,{method:'POST',headers:{Cookie:cookie,Origin:address.origin,'Content-Type':'application/x-www-form-urlencoded'},body});
  if(!sent.ok)throw new Error(`Neutral fixture approval failed: ${await sent.text()}`);
}
try {
  const source=join(temp,'fictional-cv.txt');const sourceText='Sample Person\nEducation: Bachelor of Design\nProject: Built a prototype for a student project.';writeFileSync(source,sourceText);
  run('init','--language','id','--client','opencode');
  const imported=run('source-import','--file',source).result;
  const proposed=run('profile-propose','--input',input('profile',{name:'Sample Person',facts:[{category:'project',statement:'Built a prototype for a student project.',sourceId:imported.id,excerpt:'Built a prototype for a student project.'}],preferences:{},openQuestions:['Confirm dates']})).result;
  await neutralApproval(run('review','--kind','profile','--id',proposed.id));
  const context=run('context').result;
  const vacancy=run('vacancy-add','--input',input('vacancy',{company:'Example Workshop',role:'Junior Designer',text:'Looking for someone who can build prototypes.',notes:''})).result;
  const fact=proposed.facts[0];
  const draft=run('material-create','--input',input('draft',{vacancyId:vacancy.id,language:'en',title:'Junior Designer',claims:[{section:'Projects',text:'Built a prototype for a student project.',factRefs:[{factId:fact.id,quote:fact.statement}]}],letter:{paragraphs:[{text:'I built a prototype for a student project.',factRefs:[{factId:fact.id,quote:fact.statement}]}]}})).result;
  await neutralApproval(run('review','--kind','content','--id',draft.id));
  const output=join(temp,'exports');mkdirSync(output);run('material-export','--id',draft.id,'--out',output);
  run('application-report','--input',input('report',{materialId:draft.id,dateApplied:'2026-01-01',status:'applied',operationId:'neutral-smoke'}));
  const history=run('application-list').result;if(!Array.isArray(history)||!history.some(a=>a.materialId===draft.id&&a.status==='applied'))throw new Error('Reported application was not persisted.');
  const backup=join(temp,'backup.jose.gz');run('backup-export','--out',backup);
  const restored=join(temp,'restored');const restore=spawnSync(process.execPath,[join(root,'dist','cli.js'),'backup-restore','--workspace',restored,'--file',backup],{cwd:root,encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'},timeout:90_000});
  if(restore.status!==0)throw new Error(`Restore failed: ${restore.stderr}`);
  console.log(JSON.stringify({ok:true,workspaceLanguage:'id',profileId:proposed.id,contextLoaded:!!context,vacancyId:vacancy.id,materialId:draft.id,reported:true,restored:true,note:'Fictional data and simulated local review only; no model, Jobstreet, upload or submission was used.'},null,2));
}finally{
  if(controllerStarted){try{run('stop');}catch{/* already stopped */}await new Promise(resolveWait=>setTimeout(resolveWait,400));}
  rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
