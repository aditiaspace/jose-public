import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, existsSync, lstatSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable((value as Record<string,unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function text(value: unknown, name: string, max = 1000000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be non-empty text (maximum ${max} characters).`);
  return value.trim();
}
export function inside(root: string, target: string): boolean { const r = relative(root,target); return r === '' || (r !== '..' && !r.startsWith('..'+sep) && !isAbsolute(r)); }
export function canonical(path: string): string {
  let p = resolve(path); const pieces: string[]=[];
  while (!existsSync(p)) { pieces.unshift(basename(p)); const next=dirname(p); if(next===p) break; p=next; }
  return resolve(realpathSync(p),...pieces);
}
export function assertPrivateRoot(path:string):string {
  const target=canonical(path);
  for(let parent=target;;parent=dirname(parent)) {
    if(existsSync(resolve(parent,'.git'))) throw new Error('Private workspaces and backups must be outside Git worktrees.');
    if(dirname(parent)===parent) break;
  }
  return target;
}
export function safePath(root: string, rel: string): string {
  if (!rel || isAbsolute(rel)) throw new Error('A workspace-relative path is required.');
  const target=resolve(root,rel); if(!inside(root,target)) throw new Error('Path escapes the private workspace.');
  let p=target; while(inside(root,p) && p!==root) { if(existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('Workspace symlinks/junctions are not allowed for stored artifacts.'); p=dirname(p); }
  if(!inside(canonical(root),canonical(target))) throw new Error('Path resolves outside private workspace.');
  return target;
}
export function atomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path),{recursive:true,mode:0o700}); const temp=path+'.'+id()+'.tmp';
  writeFileSync(temp,data,{mode:0o600,flag:'wx'}); renameSync(temp,path);
}
export function readJson(path: string): unknown { const raw=readFileSync(path); if(raw.length>10*1024*1024) throw new Error('JSON input exceeds 10 MB.'); return JSON.parse(raw.toString('utf8')) as unknown; }
export function escapeHtml(value: unknown): string { return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
