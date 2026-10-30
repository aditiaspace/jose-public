import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Approval, Attempt, Profile, Vacancy } from './contracts.js';
import { Workspace } from './workspace.js';
import { ApprovalNeeded, decideApproval, verifyMaterial } from './approval.js';
import { atomic, escapeHtml } from './util.js';
import { JobstreetSession } from './jobstreet.js';
import { refreshContext } from './profile.js';

const payloadSchema=z.object({operation:z.enum(['jobstreet-login','jobstreet-scrape','jobstreet-prepare','jobstreet-review','jobstreet-submit','stop']),materialId:z.string().optional(),answers:z.record(z.string(),z.string()).optional()}).strict();
const metadataSchema=z.object({url:z.string().url(),token:z.string().min(32),pid:z.number().int().positive(),workspaceId:z.string()}).strict();
type Metadata=z.infer<typeof metadataSchema>;
interface HumanSession { cookie:string; csrf:string; approvalId:string; expires:number; }
const opaque=()=>randomBytes(32).toString('hex');
function pause(ms:number):Promise<void> { const {promise,resolve}=Promise.withResolvers<void>();setTimeout(resolve,ms);return promise; }

function secureEqual(a:string,b:string):boolean { const x=Buffer.from(a), y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
function body(req:IncomingMessage,limit=200_000):Promise<string> {
  const {promise,resolve,reject}=Promise.withResolvers<string>();
  const chunks:Buffer[]=[];let size=0;
  req.on('data',(part:Buffer)=>{size+=part.length;if(size>limit){reject(new Error('Request too large.'));req.destroy();return;}chunks.push(part);});
  req.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));req.on('error',reject);
  return promise;
}
function writeResponse(res:ServerResponse,status:number,content:string,type='text/html; charset=utf-8',headers:Record<string,string>={}):void {
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",...headers});res.end(content);
}
function json(res:ServerResponse,status:number,value:unknown):void {writeResponse(res,status,JSON.stringify(value),'application/json; charset=utf-8');}
function renderPage(ws:Workspace,a:Approval,csrf:string):string {
  const lang=ws.settings().language;
  const copy=lang==='id'?{title:'Tinjau sebelum melanjutkan',instructions:'Periksa detail di bawah. Persetujuan ini hanya berlaku untuk tindakan yang ditampilkan.',approve:'Setujui tindakan ini',reject:'Perlu perubahan / batalkan',facts:'Fakta yang akan disimpan',cv:'Pratinjau CV yang akan digunakan',letter:'Surat lamaran',warning:'Jangan setujui jika ada hal yang tidak benar. Kembali ke chat untuk meminta perubahan.'}:{title:'Review before continuing',instructions:'Check the details below. This approval applies only to the action shown.',approve:'Approve this action',reject:'Request changes / cancel',facts:'Facts to save',cv:'CV preview for this revision',letter:'Cover letter',warning:'Do not approve anything inaccurate. Return to chat to request changes.'};
  const actionNames:Record<Approval['action'],string>=lang==='id'?{profile:'Simpan fakta karier',content:'Setujui isi lamaran',disclosure:'Izinkan pengungkapan ke Jobstreet',submit:'Kirim lamaran ini'}:{profile:'Save career facts',content:'Approve application content',disclosure:'Allow disclosure to Jobstreet',submit:'Submit this application'};
  let content='';
  if(a.action==='profile') {
    const profile=ws.store.require<Profile>('profiles',a.entityId);
    content=`<section><h2>${copy.facts}</h2><p><strong>${escapeHtml(profile.name)}</strong></p><p>${lang==='id'?'Centang hanya fakta yang benar-benar sesuai. Fakta yang tidak dicentang tidak akan digunakan; minta agen memperbaikinya jika perlu.':'Select only facts you confirm as accurate. Unchecked facts will not be used; ask the agent to correct them if needed.'}</p><ul>${profile.facts.map(f=>`<li><label><input type="checkbox" name="factId" value="${escapeHtml(f.id)}"> <strong>${escapeHtml(f.category)}</strong>: ${escapeHtml(f.statement)}<small><br>${lang==='id'?'Bukti sumber:':'Source evidence:'} ${escapeHtml(f.excerpt)}</small></label></li>`).join('')}</ul>${Object.keys(profile.preferences).length?`<h3>${lang==='id'?'Preferensi':'Preferences'}</h3><ul>${Object.entries(profile.preferences).map(([k,v])=>`<li>${escapeHtml(k)}: ${escapeHtml(v)}</li>`).join('')}</ul>`:''}${profile.openQuestions.length?`<h3>${lang==='id'?'Masih perlu klarifikasi':'Still needs clarification'}</h3><ul>${profile.openQuestions.map(q=>`<li>${escapeHtml(q)}</li>`).join('')}</ul>`:''}</section>`;
  } else if(a.action==='content') {
    const material=verifyMaterial(ws,a.entityId);
    const letter=ws.read(material.files.letter).toString('utf8');
    const evidence=ws.read(material.files.evidence).toString('utf8');
    const letterLanguage=material.letterLanguage==='id'?'Bahasa Indonesia':'English';
    const languageTerms=Array.isArray(material.languageTerms)?material.languageTerms.filter((term:unknown):term is string=>typeof term==='string'):[];
    const warning=languageTerms.length?`<p role="note">${lang==='id'?'Tinjau apakah kata ini bagian dari nama resmi atau perlu diterjemahkan ke bahasa Inggris:':'Review whether these terms are official names or need translation into English:'} ${escapeHtml(languageTerms.join(', '))}</p>`:'';
    const vacancy=ws.store.require<Vacancy>('vacancies',material.vacancyId);
    content=`<section><h2>${escapeHtml(vacancy.company)} · ${escapeHtml(vacancy.role)}</h2><p>${lang==='id'?'Percobaan':'Application attempt'} ${escapeHtml(material.attemptId)} · ${lang==='id'?'Revisi materi':'Material revision'} ${escapeHtml(material.id)}</p><p>${lang==='id'?'File yang ditinjau':'Files under review'}: ${escapeHtml(material.files.pdf.split('/').at(-1)??'resume.pdf')} · ${escapeHtml(material.files.letter.split('/').at(-1)??'cover-letter.txt')}</p><p>${lang==='id'?'Manifest SHA-256':'Manifest SHA-256'}: <code>${escapeHtml(material.manifestHash)}</code></p><h3>${escapeHtml(material.title)}</h3>${warning}<h3>${copy.cv}</h3><iframe title="${copy.cv}" src="/preview/${a.id}"></iframe><h3>${copy.letter} · ${letterLanguage}</h3><pre>${escapeHtml(letter)}</pre><details><summary>${lang==='id'?'Lihat bukti dan kesenjangan':'View evidence and gaps'}</summary><pre>${escapeHtml(evidence)}</pre></details></section>`;
  } else {
    content=`<section><h2>${escapeHtml(actionNames[a.action])}</h2><pre>${escapeHtml(JSON.stringify(a.summary,null,2))}</pre></section>`;
  }
  const englishCheck=a.action==='content'?`<label><input type="checkbox" name="english" value="yes" required> ${lang==='id'?'Saya sudah memeriksa bahwa CV ini berbahasa Inggris, kecuali nama resmi.':'I checked that this CV is in English, except for official names.'}</label>`:'';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jose — ${copy.title}</title><style>body{font:16px/1.55 system-ui,sans-serif;color:#202d28;background:#f4f7f4;margin:0}main{max-width:880px;margin:0 auto;padding:36px 24px 80px}header{border-bottom:1px solid #c7d6cb;padding-bottom:18px;margin-bottom:24px}h1{font-size:2rem;line-height:1.15;margin:4px 0 12px}h2{font-size:1.2rem}section{background:white;border:1px solid #d5e0d7;border-radius:10px;padding:20px;margin:16px 0}iframe{width:100%;height:70vh;border:1px solid #b7c8bb}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}small{color:#53675a}form{display:flex;gap:12px;flex-wrap:wrap}form label{flex-basis:100%}button{border:1px solid #29513b;background:#29513b;color:white;border-radius:6px;padding:12px 18px;font:inherit;cursor:pointer}button[value=reject]{background:white;color:#29513b}button:focus-visible{outline:3px solid #cb9a42;outline-offset:3px}.label{font-weight:700;letter-spacing:.08em;font-size:.8rem;color:#42674d}</style></head><body><main><header><span class="label">JOSE · ${escapeHtml(actionNames[a.action])}</span><h1>${copy.title}</h1><p>${copy.instructions}</p></header>${content}<p>${copy.warning}</p><form method="post" action="/decision/${a.id}"><input type="hidden" name="csrf" value="${csrf}">${englishCheck}<button name="decision" value="approve">${copy.approve}</button><button name="decision" value="reject" formnovalidate>${copy.reject}</button></form></main></body></html>`;
}
function cookieValue(req:IncomingMessage):string { const cookie=req.headers.cookie??'';return cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('jose_review='))?.slice('jose_review='.length)??''; }

export async function startController(ws:Workspace):Promise<void> {
  if(await readEndpoint(ws))throw new Error('The review service is already running for this workspace.');
  ws.store.tx(()=>{
    for(const attempt of ws.store.list<Attempt>('attempts')) {
      if(attempt.status==='submitting') {
        attempt.status='submission_uncertain';ws.store.put('attempts',attempt);
        ws.store.event('submission_interrupted',attempt.id,{reason:'The review service restarted before confirmation.'});
      }
    }
  });
  const token=opaque();const humans=new Map<string,HumanSession>();let browser:JobstreetSession|undefined;let port=0;
  let queue:Promise<void>=Promise.resolve();
  function serialize<T>(operation:()=>Promise<T>):Promise<T> {
    const next=queue.then(operation,operation);queue=next.then(()=>undefined,()=>undefined);return next;
  }
  const server=createServer(async(req,res)=>{
    try {
      const host=`127.0.0.1:${port}`;
      if(req.headers.host!==host) {writeResponse(res,403,'Invalid host.');return;}
      const url=new URL(req.url??'/',`http://${host}`);
      if(url.pathname==='/health'&&req.method==='GET') { if(!secureEqual(String(req.headers.authorization??''),`Bearer ${token}`)){json(res,401,{error:'Unauthorized'});return;}json(res,200,{workspaceId:ws.settings().workspaceId});return; }
      if(url.pathname==='/api/op'&&req.method==='POST') {
        if(!secureEqual(String(req.headers.authorization??''),`Bearer ${token}`)){json(res,401,{error:'Unauthorized'});return;}
        const data=payloadSchema.parse(JSON.parse(await body(req)) as unknown);
        try {
          const result=await serialize(async()=>{
            if(data.operation==='stop')return {stopping:true};
            browser??=new JobstreetSession(ws);
            switch(data.operation){
              case 'jobstreet-login':return browser.login();
              case 'jobstreet-scrape':return browser.scrape();
              case 'jobstreet-prepare':if(!data.materialId)throw new Error('materialId is required.');return browser.prepare(data.materialId,data.answers??{});
              case 'jobstreet-review':if(!data.materialId)throw new Error('materialId is required.');return browser.review(data.materialId);
              case 'jobstreet-submit':if(!data.materialId)throw new Error('materialId is required.');return browser.submit(data.materialId);
            }
          });
          json(res,200,{ok:true,...result});
          if(data.operation==='stop')setTimeout(()=>{void shutdown();},50);
        } catch(err) {if(err instanceof ApprovalNeeded){json(res,409,{ok:false,approvalRequired:true,requestId:err.request.id,reviewUrl:`http://${host}/review/${err.request.id}`});return;}throw err;}
        return;
      }
      const review=url.pathname.match(/^\/review\/([a-f0-9-]+)$/);
      if(review&&req.method==='GET') {
        const a=ws.store.require<Approval>('approvals',review[1]);
        if(a.state!=='pending'||Date.parse(a.expiresAt)<=Date.now()){writeResponse(res,410,'Review request expired or already decided.');return;}
        const session={cookie:opaque(),csrf:opaque(),approvalId:a.id,expires:Date.now()+30*60*1000};humans.set(session.cookie,session);
        writeResponse(res,200,renderPage(ws,a,session.csrf),'text/html; charset=utf-8',{'Set-Cookie':`jose_review=${session.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`});return;
      }
      const preview=url.pathname.match(/^\/preview\/([a-f0-9-]+)$/);
      if(preview&&req.method==='GET') {
        const h=humans.get(cookieValue(req));if(!h||h.expires<Date.now()||h.approvalId!==preview[1]){writeResponse(res,403,'Review session required.');return;}
        const a=ws.store.require<Approval>('approvals',preview[1]);if(a.action!=='content'||a.state!=='pending')throw new Error('Preview is unavailable.');
        const material=verifyMaterial(ws,a.entityId);const bytes=ws.read(material.files.pdf);
        res.writeHead(200,{'Content-Type':'application/pdf','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline','Content-Security-Policy':"default-src 'none'; frame-ancestors 'self'"});res.end(bytes);return;
      }
      const decision=url.pathname.match(/^\/decision\/([a-f0-9-]+)$/);
      if(decision&&req.method==='POST') {
        // Some isolated Chromium tabs submit forms with Origin: null; require the one-use cookie/CSRF and Fetch Metadata checks below as well.
        const origin=String(req.headers.origin??'');const fetchSite=String(req.headers['sec-fetch-site']??'');
        if((origin!==`http://${host}`&&origin!=='null')||(fetchSite&&fetchSite!=='same-origin'&&fetchSite!=='none')){writeResponse(res,403,'Invalid origin.');return;}
        const key=cookieValue(req),h=humans.get(key);if(!h||h.expires<Date.now()||h.approvalId!==decision[1]){writeResponse(res,403,'Review session expired.');return;}
        const form=new URLSearchParams(await body(req,5000));if(!secureEqual(form.get('csrf')??'',h.csrf)){writeResponse(res,403,'Invalid review token.');return;}
        const answer=form.get('decision');if(answer!=='approve'&&answer!=='reject')throw new Error('Invalid decision.');
        const pending=ws.store.require<Approval>('approvals',decision[1]);
        if(answer==='approve'&&pending.action==='content'&&form.get('english')!=='yes'){writeResponse(res,400,ws.settings().language==='id'?'Konfirmasi bahwa CV berbahasa Inggris sebelum menyetujui.':'Confirm the CV is in English before approving.');return;}
        const selectedFactIds=pending.action==='profile'?form.getAll('factId'):undefined;
        const result=decideApproval(ws,decision[1],answer==='approve',selectedFactIds);humans.delete(key);
        if(result.state==='approved'&&result.action==='profile')refreshContext(ws);
        const message=ws.settings().language==='id'?(result.state==='approved'?'Persetujuan tersimpan. Kembali ke chat untuk melanjutkan.':'Dibatalkan. Kembali ke chat untuk meminta perubahan.'):(result.state==='approved'?'Approval saved. Return to chat to continue.':'Cancelled. Return to chat to request changes.');
        writeResponse(res,200,`<!doctype html><html><head><meta charset="utf-8"><title>Jose</title></head><body><main><h1>${escapeHtml(message)}</h1></main></body></html>`,'text/html; charset=utf-8',{'Set-Cookie':'jose_review=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});return;
      }
      writeResponse(res,404,'Not found.');
    } catch(err) {if(!res.headersSent)json(res,400,{error:err instanceof Error?err.message:'Request failed.'});}
  });
  const runtime=ws.path('.jose-runtime/controller.json');
  const shutdown=async()=>{try{if(browser)await browser.close();}finally{server.close();try{const current=metadataSchema.parse(JSON.parse(readFileSync(runtime,'utf8')) as unknown);if(current.token===token)unlinkSync(runtime);}catch{/* already removed */}ws.close();}};
  const listening=Promise.withResolvers<void>();server.once('error',listening.reject);server.listen(0,'127.0.0.1',listening.resolve);await listening.promise;
  const addr=server.address();if(!addr||typeof addr==='string')throw new Error('Unable to bind local review controller.');port=addr.port;
  atomic(runtime,JSON.stringify({url:`http://127.0.0.1:${port}`,token,pid:process.pid,workspaceId:ws.settings().workspaceId}));
  process.on('SIGINT',()=>{void shutdown();});process.on('SIGTERM',()=>{void shutdown();});
}

async function readEndpoint(ws:Workspace):Promise<Metadata|null> {
  try {
    const m=metadataSchema.parse(JSON.parse(readFileSync(ws.path('.jose-runtime/controller.json'),'utf8')) as unknown);
    if(m.workspaceId!==ws.settings().workspaceId || !/^http:\/\/127\.0\.0\.1:\d+$/.test(m.url))return null;
    const r=await fetch(`${m.url}/health`,{headers:{Authorization:`Bearer ${m.token}`},signal:AbortSignal.timeout(1200)});
    if(!r.ok)return null;const value=z.object({workspaceId:z.string()}).parse(await r.json());return value.workspaceId===m.workspaceId?m:null;
  }catch{return null;}
}
export async function ensureController(ws:Workspace):Promise<Metadata> {
  const existing=await readEndpoint(ws);if(existing)return existing;
  const lock=ws.path('.jose-runtime/start.lock');mkdirSync(dirname(lock),{recursive:true});let holder=false;
  for(let i=0;i<200;i++) {
    const live=await readEndpoint(ws);if(live)return live;
    try {const fd=openSync(lock,'wx',0o600);closeSync(fd);holder=true;break;}catch(err){if((err as NodeJS.ErrnoException).code!=='EEXIST')throw err;try{if(Date.now()-statSync(lock).mtimeMs>30_000)unlinkSync(lock);}catch{/* another starter finished */}await pause(100);}
  }
  if(!holder)throw new Error('Timed out waiting for the local review service.');
  try {
    const live=await readEndpoint(ws);if(live)return live;
    const entry=resolve(dirname(fileURLToPath(import.meta.url)),'cli.js');
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) && key!=='NODE_OPTIONS'));
    const child=spawn(process.execPath,[entry,'serve','--workspace',ws.root],{detached:true,stdio:'ignore',windowsHide:true,env});child.unref();
    for(let i=0;i<150;i++){const m=await readEndpoint(ws);if(m)return m;await pause(100);}
    throw new Error('The local review service failed to start. Run jose serve to inspect the error.');
  }finally{try{unlinkSync(lock);}catch{/* already removed */}}
}
export async function controllerOperation(ws:Workspace,operation:string,data:Record<string,unknown>={}):Promise<Record<string,unknown>> {
  const m=await ensureController(ws);
  const res=await fetch(`${m.url}/api/op`,{method:'POST',headers:{Authorization:`Bearer ${m.token}`,'Content-Type':'application/json'},body:JSON.stringify({operation,...data}),signal:AbortSignal.timeout(120_000)});
  const value=z.record(z.string(),z.unknown()).parse(await res.json());
  if(!res.ok&&!value.approvalRequired)throw new Error(String(value.error??'Local operation failed.'));
  return value;
}
export async function reviewUrl(ws:Workspace,approval:Approval):Promise<string> { const m=await ensureController(ws);return `${m.url}/review/${approval.id}`; }
