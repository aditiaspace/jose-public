#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Approval, Profile, Vacancy } from './contracts.js';
import { Workspace, initWorkspace } from './workspace.js';
import { readJson } from './util.js';
import { importSource } from './documents.js';
import { proposeProfile, getContext, refreshContext } from './profile.js';
import { captureVacancy, createMaterial, exportMaterial, inspectEditedDocx } from './materials.js';
import { configureWorkspace, workspaceDoctor } from './skills.js';
import { reportApplication, listApplications, applicationHistory } from './recording.js';
import { exportBackup, restoreBackup } from './backup.js';
import { bindingFor, decideApproval, requestApproval, verifyMaterial } from './approval.js';
import { controllerOperation, startController } from './controller.js';

const help=`Jose — private local job-search workspace

Usage: jose <operation> --workspace <private-directory> [options]

  init --language en|id
  doctor | context | language-set --language en|id
  source-import --file <CV> | profile-propose --input <JSON>
  workflow-preferences --input <JSON>
  vacancy-add --input <JSON> | vacancy-list
  material-edit-inspect --id <material> [--file <workspace-relative-docx>]
  material-create --input <JSON> | material-export --id <material> --out <directory>
  review --kind profile|content --id <revision> | approval-decide --input <JSON> | review-status --id <request>
  jobstreet-login | jobstreet-scrape | jobstreet-prepare --id <material> --input <answers JSON>
  jobstreet-review --id <material> | jobstreet-submit --id <material>
  application-report --input <JSON> | application-list | application-history [--id <attempt>]
  backup-export --out <archive> | backup-restore --file <archive> --workspace <new-directory>
  serve | stop

Human decisions happen in chat; approval records are persisted locally and bound to the reviewed revision.
`;
const answerSchema=z.record(z.string(),z.string());
const reportSchema=z.object({attemptId:z.string().optional(),vacancyId:z.string().optional(),materialId:z.string().optional(),dateApplied:z.string().nullable().optional(),status:z.string().optional(),evidence:z.unknown().optional(),operationId:z.string().optional(),reapply:z.boolean().optional()}).strict();
const approvalDecisionSchema=z.object({requestId:z.string().trim().min(1).max(100),decision:z.enum(['approve','reject']),selectedFactIds:z.array(z.string().trim().min(1).max(100)).max(500).optional()}).strict();
const workflowPreferencesSchema=z.object({editingMode:z.enum(['self_edit','chat']).optional(),resumeFormat:z.enum(['bullet','paragraph']).optional()}).strict().refine(value=>value.editingMode!==undefined||value.resumeFormat!==undefined,'Set editingMode or resumeFormat.');
function required(value:string|undefined,name:string):string {if(!value?.trim())throw new Error(`${name} is required.`);return value;}
function jsonInput(path:string|undefined):unknown {return readJson(resolve(required(path,'--input')));}

async function main():Promise<void> {
  const args=parseArgs({args:process.argv.slice(2),allowPositionals:true,strict:true,options:{workspace:{type:'string'},input:{type:'string'},file:{type:'string'},id:{type:'string'},kind:{type:'string'},out:{type:'string'},language:{type:'string'},help:{type:'boolean',short:'h'}}});
  const op=args.positionals[0];if(args.values.help||!op||op==='help'){process.stdout.write(help);return;}
  if(args.positionals.length!==1)throw new Error('Supply exactly one operation.');
  const root=resolve(required(args.values.workspace,'--workspace'));
  const language=args.values.language===undefined?undefined:z.enum(['en','id']).parse(args.values.language);
  if(op==='backup-restore') {const restored=await restoreBackup(resolve(required(args.values.file,'--file')),root);try{configureWorkspace(restored);refreshContext(restored);process.stdout.write(JSON.stringify({ok:true,workspace:restored.root,workspaceId:restored.settings().workspaceId,restored:true})+'\n');}finally{restored.close();}return;}
  if(op==='init') {
    if(!language)throw new Error('Choose --language en|id.');
    const ws=initWorkspace(root,language);try{configureWorkspace(ws);process.stdout.write(JSON.stringify({ok:true,workspace:ws.root,workspaceId:ws.settings().workspaceId,language:ws.settings().language,onboarding:ws.settings().onboarding})+'\n');}finally{ws.close();}return;
  }
  const ws=new Workspace(root);
  if(op==='serve'){await startController(ws);return;}
  try {
    let result:unknown;
    switch(op) {
      case 'doctor':result={workspace:ws.root,workspaceId:ws.settings().workspaceId,node:process.version,...await workspaceDoctor(ws),onboarding:ws.settings().onboarding};break;
      case 'context':result=getContext(ws);break;
      case 'language-set':{if(!language)throw new Error('--language en|id is required.');const s=ws.settings();s.language=language;ws.store.put('settings',s);refreshContext(ws);result={language};break;}
      case 'workflow-preferences':{
        const input=workflowPreferencesSchema.parse(jsonInput(args.values.input));
        const settings=ws.settings();
        if(input.editingMode!==undefined)settings.editingMode=input.editingMode;
        if(input.resumeFormat!==undefined)settings.resumeFormat=input.resumeFormat;
        ws.store.put('settings',settings);refreshContext(ws);
        result={editingMode:settings.editingMode??null,resumeFormat:settings.resumeFormat??null};break;
      }
      case 'source-import':result=await importSource(ws,resolve(required(args.values.file,'--file')));break;
      case 'profile-propose':result=proposeProfile(ws,jsonInput(args.values.input));break;
      case 'vacancy-add':result=await captureVacancy(ws,jsonInput(args.values.input));break;
      case 'vacancy-list':result=ws.store.list('vacancies');break;
      case 'material-create':result=await createMaterial(ws,jsonInput(args.values.input));break;
      case 'material-export':result=await exportMaterial(ws,required(args.values.id,'--id'),required(args.values.out,'--out'));break;
      case 'material-edit-inspect':result=await inspectEditedDocx(ws,required(args.values.id,'--id'),args.values.file);break;
      case 'review':{
        const kind=z.enum(['profile','content']).parse(args.values.kind);const entityId=required(args.values.id,'--id');let attemptId:string|undefined;let summary:Record<string,unknown>;
        if(kind==='profile'){
          const profile=ws.store.require<Profile>('profiles',entityId);
          if(profile.confirmedAt){result={alreadyApproved:true,profileId:profile.id};break;}
          summary={kind,entityId,name:profile.name,facts:profile.facts.map(({id:factId,category,statement,sourceId,excerpt})=>({factId,category,statement,sourceId,quote:excerpt})),openQuestions:profile.openQuestions};
        }else{
          const material=verifyMaterial(ws,entityId);
          attemptId=material.attemptId;
          if(material.approvedAt){result={alreadyApproved:true,materialId:material.id};break;}
          const evidence=JSON.parse(ws.read(material.files.evidence).toString('utf8')) as Record<string,unknown>;
          const vacancy=ws.store.require<Vacancy>('vacancies',material.vacancyId);
          const reviewFiles=Object.fromEntries(Object.entries(material.files).filter(([fileKind])=>material.editingMode!=='self_edit'||fileKind!=='html'));
          summary={kind,entityId,materialId:material.id,attemptId:material.attemptId,title:material.title,vacancy:{company:vacancy.company,role:vacancy.role,url:vacancy.url??null},files:reviewFiles,manifestHash:material.manifestHash,claims:evidence.claims,letter:evidence.letter,...(typeof evidence.editedDocxText==='string'?{resumeText:evidence.editedDocxText}:{}),...(Array.isArray(evidence.docxConversionWarnings)?{docxConversionWarnings:evidence.docxConversionWarnings}:{}),...(typeof evidence.pdfRenderingNote==='string'?{pdfRenderingNote:evidence.pdfRenderingNote}:{}),reviewNote:evidence.reviewNote};
        }
        const binding=bindingFor(ws,kind,entityId);
        const approval=requestApproval(ws,kind,entityId,binding,summary,attemptId);
        result={approvalRequired:true,requestId:approval.id,action:approval.action,entityId:approval.entityId,expiresAt:approval.expiresAt,summary:approval.summary};break;
      }
      case 'approval-decide':{
        const input=approvalDecisionSchema.parse(jsonInput(args.values.input));
        const approval=decideApproval(ws,input.requestId,input.decision==='approve',input.selectedFactIds);
        let confirmedFactIds:string[]|undefined;
        if(approval.state==='approved'&&approval.action==='profile'){
          refreshContext(ws);
          confirmedFactIds=ws.store.require<Profile>('profiles',approval.entityId).facts.filter(fact=>fact.confirmed).map(fact=>fact.id);
        }
        result={requestId:approval.id,action:approval.action,entityId:approval.entityId,state:approval.state,decidedAt:approval.decidedAt,...(confirmedFactIds?{confirmedFactIds}:{})};break;
      }
      case 'review-status':{const a=ws.store.require<Approval>('approvals',required(args.values.id,'--id'));result={requestId:a.id,action:a.action,state:a.state,entityId:a.entityId,expiresAt:a.expiresAt,decidedAt:a.decidedAt};break;}
      case 'jobstreet-login':case 'jobstreet-scrape':case 'stop':result=await controllerOperation(ws,op);break;
      case 'jobstreet-prepare':{const answers=args.values.input?answerSchema.parse(jsonInput(args.values.input)):{};result=await controllerOperation(ws,op,{materialId:required(args.values.id,'--id'),answers});break;}
      case 'jobstreet-review':case 'jobstreet-submit':result=await controllerOperation(ws,op,{materialId:required(args.values.id,'--id')});break;
      case 'application-report':{const input=reportSchema.parse(jsonInput(args.values.input));result=reportApplication(ws,{...input,provenance:'user_reported'});break;}
      case 'application-list':result=listApplications(ws);break;
      case 'application-history':result=applicationHistory(ws,args.values.id);break;
      case 'backup-export':result=await exportBackup(ws,resolve(required(args.values.out,'--out')));break;
      default:throw new Error(`Unknown operation: ${op}. Run the local CLI with --help for the command list.`);
    }
    process.stdout.write(JSON.stringify({ok:true,operation:op,result},null,2)+'\n');
  }finally{ws.close();}
}
main().catch((error:unknown)=>{process.stderr.write(JSON.stringify({ok:false,error:error instanceof Error?error.message:'Operation failed.'})+'\n');process.exitCode=1;});
