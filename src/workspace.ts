import { mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import type { Settings, Client, Language } from './contracts.js';
import { assertPrivateRoot, atomic, id, inside, now, safePath } from './util.js';
export const INSTALL_ROOT=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
export class Workspace {
  readonly root:string; readonly store:Store;
  constructor(root:string) {
    this.root=assertPrivateRoot(root);
    if(inside(INSTALL_ROOT,this.root)) throw new Error('Private workspace must be outside the Jose tooling checkout.');
    if(!existsSync(resolve(this.root,'.jose-workspace'))) throw new Error('Not a Jose workspace. Run init with an external private directory.');
    const database=safePath(this.root,'state/jose.sqlite');
    if(!existsSync(database)) throw new Error('Workspace database is missing; restore it from backup.');
    this.store=new Store(database);
    this.settings();
  }
  settings():Settings { return this.store.require<Settings>('settings','settings'); }
  path(rel:string):string { return safePath(this.root,rel); }
  read(rel:string):Buffer { return readFileSync(this.path(rel)); }
  write(rel:string,data:string|Uint8Array):string { const p=this.path(rel);atomic(p,data);return p; }
  close():void { this.store.close(); }
}
export function initWorkspace(root:string, language:Language='en', client:Client='opencode'):Workspace {
  if(!['en','id'].includes(language)||!['opencode','harness'].includes(client)) throw new Error('Unsupported conversation language or client.');
  const target=assertPrivateRoot(root);
  if(inside(INSTALL_ROOT,target)) throw new Error('Private workspace must be outside the Jose tooling checkout.');
  if(existsSync(resolve(target,'.jose-workspace'))) return new Workspace(target);
  const dirs=['state','sources','context','applications','browser','client-config','.jose-runtime'];
  for(const dir of dirs) if(existsSync(resolve(target,dir))) throw new Error(`Cannot initialize: ${dir} already exists. Choose an empty workspace.`);
  for(const dir of dirs) mkdirSync(resolve(target,dir),{recursive:true,mode:0o700});
  const store=new Store(resolve(target,'state/jose.sqlite'));
  try{store.create<Settings>('settings',{id:'settings',workspaceId:id(),language,client,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,createdAt:now(),onboarding:'not_started'});}finally{store.close();}
  atomic(resolve(target,'.jose-workspace'),'1\n');
  return new Workspace(target);
}
