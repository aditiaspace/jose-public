import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Attempt } from './contracts.js';
import { Workspace } from './workspace.js';
import { ApprovalNeeded } from './approval.js';
import { atomic } from './util.js';
import { JobstreetSession } from './jobstreet.js';

const payloadSchema=z.object({operation:z.enum(['jobstreet-login','jobstreet-scrape','jobstreet-prepare','jobstreet-review','jobstreet-submit','stop']),materialId:z.string().optional(),answers:z.record(z.string(),z.string()).optional()}).strict();
const metadataSchema=z.object({url:z.string().url(),token:z.string().min(32),pid:z.number().int().positive(),workspaceId:z.string()}).strict();
type Metadata=z.infer<typeof metadataSchema>;
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

export async function startController(ws:Workspace):Promise<void> {
  if(await readEndpoint(ws))throw new Error('The Jose local tool service is already running for this workspace.');
  ws.store.tx(()=>{
    for(const attempt of ws.store.list<Attempt>('attempts')) {
      if(attempt.status==='submitting') {
        attempt.status='submission_uncertain';ws.store.put('attempts',attempt);
        ws.store.event('submission_interrupted',attempt.id,{reason:'The local tool service restarted before confirmation.'});
      }
    }
  });
  const token=opaque();let browser:JobstreetSession|undefined;let port=0;
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
        } catch(err) {if(err instanceof ApprovalNeeded){const request=err.request;json(res,409,{ok:false,approvalRequired:true,requestId:request.id,action:request.action,entityId:request.entityId,attemptId:request.attemptId??null,expiresAt:request.expiresAt,summary:request.summary});return;}throw err;}
        return;
      }
      writeResponse(res,404,'Not found.');
    } catch(err) {if(!res.headersSent)json(res,400,{error:err instanceof Error?err.message:'Request failed.'});}
  });
  const runtime=ws.path('.jose-runtime/controller.json');
  const shutdown=async()=>{try{if(browser)await browser.close();}finally{server.close();try{const current=metadataSchema.parse(JSON.parse(readFileSync(runtime,'utf8')) as unknown);if(current.token===token)unlinkSync(runtime);}catch{/* already removed */}ws.close();}};
  const listening=Promise.withResolvers<void>();server.once('error',listening.reject);server.listen(0,'127.0.0.1',listening.resolve);await listening.promise;
  const addr=server.address();if(!addr||typeof addr==='string')throw new Error('Unable to bind the Jose local tool service.');port=addr.port;
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
  if(!holder)throw new Error('Timed out waiting for the Jose local tool service.');
  try {
    const live=await readEndpoint(ws);if(live)return live;
    const entry=resolve(dirname(fileURLToPath(import.meta.url)),'cli.js');
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) && key!=='NODE_OPTIONS'));
    const child=spawn(process.execPath,[entry,'serve','--workspace',ws.root],{detached:true,stdio:'ignore',windowsHide:true,env});child.unref();
    for(let i=0;i<150;i++){const m=await readEndpoint(ws);if(m)return m;await pause(100);}
    throw new Error('The Jose local tool service failed to start. Run node .jose/node_modules/jose-workspace/dist/cli.js serve --workspace . from the workspace root to inspect the error.');
  }finally{try{unlinkSync(lock);}catch{/* already removed */}}
}
export async function controllerOperation(ws:Workspace,operation:string,data:Record<string,unknown>={}):Promise<Record<string,unknown>> {
  const m=await ensureController(ws);
  const res=await fetch(`${m.url}/api/op`,{method:'POST',headers:{Authorization:`Bearer ${m.token}`,'Content-Type':'application/json'},body:JSON.stringify({operation,...data}),signal:AbortSignal.timeout(120_000)});
  const value=z.record(z.string(),z.unknown()).parse(await res.json());
  if(!res.ok&&!value.approvalRequired)throw new Error(String(value.error??'Local operation failed.'));
  return value;
}
