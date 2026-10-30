import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Entity, Kind } from './contracts.js';
import { now, id } from './util.js';

const entity=z.object({id:z.string().min(1)});
const fact=z.object({id:z.string(),category:z.string(),statement:z.string(),sourceId:z.string(),excerpt:z.string(),confirmed:z.boolean()}).passthrough();
const schemas:Record<Kind,z.ZodType>={
  settings:entity.extend({id:z.literal('settings'),workspaceId:z.string().min(1),language:z.enum(['en','id']),timezone:z.string(),createdAt:z.string(),profileId:z.string().optional(),onboarding:z.enum(['not_started','collecting','awaiting_confirmation','ready'])}),
  sources:entity.extend({name:z.string(),path:z.string(),hash:z.string(),text:z.string(),warnings:z.array(z.string()),createdAt:z.string()}).passthrough(),
  profiles:entity.extend({name:z.string(),facts:z.array(fact),preferences:z.record(z.string(),z.string()),openQuestions:z.array(z.string()),createdAt:z.string(),confirmedAt:z.string().optional()}).passthrough(),
  vacancies:entity.extend({company:z.string(),role:z.string(),text:z.string(),url:z.string().optional(),portalId:z.string().optional(),capturedAt:z.string(),lastCheckedAt:z.string().optional(),lifecycle:z.enum(['live','expired','unknown']).optional(),notes:z.string(),possibleDuplicates:z.array(z.string())}).passthrough(),
  materials:entity.extend({attemptId:z.string(),vacancyId:z.string(),profileId:z.string(),language:z.literal('en'),letterLanguage:z.enum(['en','id']).optional(),createdAt:z.string(),files:z.object({html:z.string(),pdf:z.string(),letter:z.string(),evidence:z.string()}),fileHashes:z.record(z.string(),z.string()),manifestHash:z.string(),title:z.string(),approvedAt:z.string().optional()}).passthrough(),
  approvals:entity.extend({action:z.enum(['profile','content','disclosure','submit']),entityId:z.string(),attemptId:z.string().optional(),binding:z.string(),summary:z.unknown(),state:z.enum(['pending','approved','rejected','consumed']),createdAt:z.string(),expiresAt:z.string(),decidedAt:z.string().optional()}).passthrough(),
  attempts:entity.extend({vacancyId:z.string(),materialId:z.string().optional(),createdAt:z.string(),status:z.string(),dateApplied:z.string().nullable().optional(),provenance:z.enum(['user_reported','portal_observed']).optional(),evidence:z.unknown().optional(),submissionBinding:z.string().optional()}).passthrough(),
};
function decode<T extends Entity>(kind:Kind,raw:unknown):T {
  // Each SQLite kind is validated against its corresponding domain schema.
  return schemas[kind].parse(raw) as T;
}
export class Store {
  readonly db: DatabaseSync;
  private depth=0;
  constructor(path: string) {
    this.db=new DatabaseSync(path,{timeout:5000});
    const version=this.db.prepare('PRAGMA user_version').get();
    if(Number(version?.user_version??0)>1) {this.db.close();throw new Error('Workspace was created by a newer Jose version. Update before opening it.');}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,kind TEXT NOT NULL,entity_id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_entity ON events(entity_id,at);
      PRAGMA user_version=1;`);
  }
  get<T extends Entity>(kind: Kind, key: string): T | null { const r=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,key); return r ? decode<T>(kind,JSON.parse(String(r.data)) as unknown) : null; }
  require<T extends Entity>(kind: Kind,key:string):T { const r=this.get<T>(kind,key); if(!r) throw new Error(`${kind} record not found: ${key}`); return r; }
  list<T extends Entity>(kind: Kind):T[] { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r=>decode<T>(kind,JSON.parse(String(r.data)) as unknown)); }
  create<T extends Entity>(kind:Kind,value:T):T { const clean=decode<T>(kind,value);this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run(kind,clean.id,JSON.stringify(clean)); return clean; }
  put<T extends Entity>(kind:Kind,value:T):T { const clean=decode<T>(kind,value);this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,version=records.version+1').run(kind,clean.id,JSON.stringify(clean)); return clean; }
  tx<T>(fn:()=>T):T { if(this.depth) return fn(); this.db.exec('BEGIN IMMEDIATE'); this.depth++; try { const out=fn(); this.db.exec('COMMIT');return out; } catch(e) { this.db.exec('ROLLBACK');throw e; } finally {this.depth--;} }
  event(kind:string,entityId:string,payload:unknown):void { this.db.prepare('INSERT INTO events(id,kind,entity_id,payload,at) VALUES(?,?,?,?,?)').run(id(),kind,entityId,JSON.stringify(payload),now()); }
  events(entityId?:string):unknown[] { const rows=entityId?this.db.prepare('SELECT * FROM events WHERE entity_id=? ORDER BY rowid').all(entityId):this.db.prepare('SELECT * FROM events ORDER BY rowid').all();return rows.map(r=>({...r,payload:JSON.parse(String(r.payload)) as unknown})); }
  close():void { this.db.close(); }
}
