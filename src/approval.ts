import type { Approval, ApprovalAction, Attempt, Material, Profile, Settings } from './contracts.js';
import type { Workspace } from './workspace.js';
import { hash, id, now, stable } from './util.js';

const TTL_MS=30*60*1000;

export class ApprovalNeeded extends Error {
  readonly request:Approval;
  constructor(request:Approval) { super('A human decision is required before this action.');this.name='ApprovalNeeded';this.request=request; }
}

/** Immutable manifest covers the actual PDF, HTML, letter and evidence; never just a filename. */
export function verifyMaterial(ws:Workspace,materialId:string):Material {
  const material=ws.store.require<Material>('materials',materialId);
  if(material.language!=='en') throw new Error('CV/resume language must be English.');
  const settings=ws.settings();
  if(!settings.profileId || settings.profileId!==material.profileId || settings.onboarding!=='ready') throw new Error('The career profile has changed; create a new draft and review it.');
  const profile=ws.store.require<Profile>('profiles',material.profileId);
  if(!profile.confirmedAt) throw new Error('Career facts have not been confirmed.');
  const attempt=ws.store.require<Attempt>('attempts',material.attemptId);
  if(attempt.vacancyId!==material.vacancyId || (attempt.materialId && attempt.materialId!==material.id)) throw new Error('The current application revision has changed.');
  const entries=Object.values(material.files);
  if(entries.length!==4 || new Set(entries).size!==4 || entries.some(p=>typeof p!=='string')) throw new Error('Invalid document manifest.');
  if(Object.keys(material.fileHashes).length!==entries.length) throw new Error('Invalid document hashes.');
  for(const path of entries) {
    if(!Object.hasOwn(material.fileHashes,path) || hash(ws.read(path))!==material.fileHashes[path]) throw new Error(`Document changed after drafting: ${path}`);
  }
  const manifest=hash(stable({materialId:material.id,attemptId:material.attemptId,vacancyId:material.vacancyId,profileId:material.profileId,language:material.language,files:material.files,fileHashes:material.fileHashes}));
  if(manifest!==material.manifestHash) throw new Error('The document manifest has changed.');
  return material;
}

export function bindingFor(ws:Workspace,action:'profile'|'content',entityId:string):string {
  const workspaceId=ws.settings().workspaceId;
  if(action==='profile') {
    const profile=ws.store.require<Profile>('profiles',entityId);
    if(profile.confirmedAt) throw new Error('This profile revision is already confirmed.');
    return hash(stable({workspaceId,action,profile}));
  }
  const material=verifyMaterial(ws,entityId);
  return hash(stable({workspaceId,action,materialId:material.id,manifestHash:material.manifestHash}));
}

export function requestApproval(ws:Workspace,action:ApprovalAction,entityId:string,binding:string,summary:unknown,attemptId?:string):Approval {
  if(!['profile','content','disclosure','submit'].includes(action) || !entityId || !binding) throw new Error('Invalid approval request.');
  return ws.store.tx(()=>{
    if(action==='profile'||action==='content') {
      if(bindingFor(ws,action,entityId)!==binding) throw new Error('The approval request is stale.');
    }
    const existing=ws.store.list<Approval>('approvals').find(a=>a.action===action && a.entityId===entityId && a.attemptId===attemptId && a.binding===binding && a.state==='pending' && Date.parse(a.expiresAt)>Date.now());
    if(existing) return existing;
    const created=now();
    return ws.store.create<Approval>('approvals',{id:id(),action,entityId,...(attemptId?{attemptId}:{}),binding,summary,state:'pending',createdAt:created,expiresAt:new Date(Date.now()+TTL_MS).toISOString()});
  });
}

export function authorize(ws:Workspace,action:ApprovalAction,entityId:string,binding:string,summary:unknown,consume=false,attemptId?:string):Approval {
  if(action==='profile'||action==='content') {
    if(bindingFor(ws,action,entityId)!==binding) throw new Error('The approval no longer matches the current data.');
  }
  const match=ws.store.list<Approval>('approvals').find(a=>a.action===action && a.entityId===entityId && a.attemptId===attemptId && a.binding===binding && a.state==='approved' && (action==='content' || Date.parse(a.expiresAt)>Date.now()));
  if(!match) throw new ApprovalNeeded(requestApproval(ws,action,entityId,binding,summary,attemptId));
  if(!consume) return match;
  return ws.store.tx(()=>{
    const current=ws.store.require<Approval>('approvals',match.id);
    if(current.state!=='approved'||Date.parse(current.expiresAt)<=Date.now()) throw new Error('Approval has already been consumed or expired.');
    current.state='consumed';ws.store.put('approvals',current);ws.store.event('approval_consumed',current.id,{action,entityId});return current;
  });
}

/** Atomically consume a per-attempt send approval and persist the pre-click state. */
export function consumeSubmission(ws:Workspace,materialId:string,binding:string,summary:unknown,attemptId:string):Approval {
  const existingAttempt=ws.store.require<Attempt>('attempts',attemptId);
  if(['submitting','submission_uncertain','applied','screening','interview','offer','rejected','withdrawn','closed'].includes(existingAttempt.status)) throw new Error('This attempt is already submitted or has an uncertain outcome.');
  const contentBinding=bindingFor(ws,'content',materialId);
  authorize(ws,'content',materialId,contentBinding,{materialId},false,attemptId);
  const matched=authorize(ws,'submit',materialId,binding,summary,false,attemptId);
  return ws.store.tx(()=>{
    const current=ws.store.require<Approval>('approvals',matched.id);
    if(current.state!=='approved'||Date.parse(current.expiresAt)<=Date.now()) throw new Error('Submission approval has already been consumed or expired.');
    const material=verifyMaterial(ws,materialId);
    const attempt=ws.store.require<Attempt>('attempts',attemptId);
    if(material.attemptId!==attemptId || ['submitting','submission_uncertain','applied','screening','interview','offer','rejected','withdrawn','closed'].includes(attempt.status)) throw new Error('This attempt is already submitted or has an uncertain outcome.');
    current.state='consumed';ws.store.put('approvals',current);
    attempt.status='submitting';attempt.submissionBinding=binding;ws.store.put('attempts',attempt);
    ws.store.event('submission_started',attemptId,{approvalId:current.id,materialId,binding});
    return current;
  });
}

/** Only the loopback review UI invokes this; no CLI/API route exposes an approval flag. */
export function decideApproval(ws:Workspace,approvalId:string,accepted:boolean,selectedFactIds?:string[]):Approval {
  return ws.store.tx(()=>{
    const a=ws.store.require<Approval>('approvals',approvalId);
    if(a.state!=='pending' || Date.parse(a.expiresAt)<=Date.now()) throw new Error('This request is no longer pending.');
    if(a.action==='profile'||a.action==='content') {
      if(bindingFor(ws,a.action,a.entityId)!==a.binding) throw new Error('The data changed. Open a fresh review.');
    }
    if(accepted && a.action==='profile') {
      const profile=ws.store.require<Profile>('profiles',a.entityId);
      const selected=selectedFactIds===undefined?new Set(profile.facts.map(fact=>fact.id)):new Set(selectedFactIds);
      if(selectedFactIds!==undefined&&selected.size!==selectedFactIds.length) throw new Error('Fact selection contains duplicates.');
      if(selected.size===0) throw new Error('Confirm at least one supported career fact or reject the proposal.');
      if([...selected].some(factId=>!profile.facts.some(fact=>fact.id===factId))) throw new Error('Fact selection does not match this profile proposal.');
      profile.facts=profile.facts.map(fact=>({...fact,confirmed:selected.has(fact.id)}));profile.confirmedAt=now();
      if(!profile.facts.some(fact=>fact.confirmed)) throw new Error('At least one supported career fact is required.');
      ws.store.put('profiles',profile);
      const settings=ws.settings();settings.profileId=profile.id;settings.onboarding='ready';ws.store.put<Settings>('settings',settings);
      ws.store.event('profile_confirmed',profile.id,{approvalId:a.id,confirmedFactIds:[...selected],unconfirmedFactIds:profile.facts.filter(fact=>!fact.confirmed).map(fact=>fact.id)});
    }
    if(accepted && a.action==='content') {
      const material=verifyMaterial(ws,a.entityId);material.approvedAt=now();ws.store.put('materials',material);
      const attempt=ws.store.require<Attempt>('attempts',material.attemptId);attempt.materialId=material.id;attempt.status='content_approved';ws.store.put('attempts',attempt);
      ws.store.event('material_approved',material.id,{approvalId:a.id,manifestHash:material.manifestHash});
    }
    a.state=accepted?'approved':'rejected';a.decidedAt=now();ws.store.put('approvals',a);ws.store.event('approval_decided',a.id,{action:a.action,accepted});return a;
  });
}
