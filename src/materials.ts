import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { lookup as lookupDns } from 'node:dns/promises';
import { request as httpsRequest, Agent } from 'node:https';
import { isIP } from 'node:net';
import { Document, HeadingLevel, Packer, Paragraph, TextRun, convertInchesToTwip, convertMillimetersToTwip } from 'docx';
import { PDFDocument } from 'pdf-lib';
import { chromium, type Browser } from 'playwright';
import mammoth from 'mammoth';
import { z } from 'zod';
import type { Attempt, Fact, Material, Profile, Source, Vacancy } from './contracts.js';
import { authorize, bindingFor, materialManifestHash, requestApproval, verifyMaterial } from './approval.js';
import { extractPdfText } from './documents.js';
import { INSTALL_ROOT, type Workspace } from './workspace.js';
import { findChromiumRuntime } from './browser-runtime.js';
import { assertPrivateRoot, escapeHtml, hash, id, inside, now, stable } from './util.js';

const VACANCY_INPUT = z.object({
  company: z.string().trim().min(1).max(300),
  role: z.string().trim().min(1).max(300),
  text: z.string().trim().min(1).max(100_000).optional(),
  url: z.url().trim().max(2000).refine(value => {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password;
  }, 'Vacancy URL must be HTTP(S) without embedded credentials.').optional(),
  portalId: z.string().trim().min(1).max(300).optional(),
  notes: z.string().max(10_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.text && !value.url) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Provide pasted vacancy text or a user-provided URL.' });
});
const MAX_VACANCY_RESPONSE_BYTES = 2 * 1024 * 1024;
const FETCHED_VACANCY_TEXT = z.string().trim().min(1).max(100_000);

const FACT_REF_INPUT = z.object({
  factId: z.string().trim().min(1).max(100),
  quote: z.string().trim().min(1).max(4000),
}).strict();
const CLAIM_INPUT = z.object({
  section: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(2000),
  factRefs: z.array(FACT_REF_INPUT).min(1).max(20),
}).strict();
const MATERIAL_INPUT = z.object({
  vacancyId: z.string().trim().min(1).max(100),
  attemptId: z.string().trim().min(1).max(100).optional(),
  language: z.literal('en'),
  resumeFormat: z.enum(['bullet','paragraph']).optional(),
  editedDocxFile: z.string().trim().min(1).max(4096).optional(),
  editedDocxHash: z.string().trim().min(1).max(128).optional(),
  title: z.string().trim().min(1).max(160),
  claims: z.array(CLAIM_INPUT).min(1).max(200),
  letter: z.object({
    language: z.enum(['en','id']).optional(),
    greeting: z.string().trim().min(1).max(300).optional(),
    paragraphs: z.array(z.object({
      text: z.string().trim().min(1).max(3000),
      factRefs: z.array(FACT_REF_INPUT).min(1).max(20),
    }).strict()).min(1).max(40),
    closing: z.string().trim().min(1).max(300).optional(),
  }).strict(),
}).strict().superRefine((value,ctx)=>{
  if((value.editedDocxFile===undefined)!==(value.editedDocxHash===undefined))ctx.addIssue({code:'custom',path:['editedDocxHash'],message:'editedDocxFile and editedDocxHash must be provided together.'});
});
const EXPORT_INPUT = z.object({
  materialId: z.string().trim().min(1).max(100),
  outDir: z.string().trim().min(1).max(4096).refine(path => !path.includes('\0'), 'Export path contains an invalid character.'),
}).strict();

const SUBMITTED_STATUS: Record<string, true> = {
  submitting: true,
  submission_uncertain: true,
  applied: true,
  screening: true,
  assessment: true,
  interview: true,
  offer: true,
  rejected: true,
  withdrawn: true,
  not_selected: true,
  closed: true,
};
const BAHASA_MARKERS: Record<string, true> = {
  pengalaman: true, pendidikan: true, keahlian: true, keterampilan: true, kemampuan: true,
  berpengalaman: true, bertanggung: true, melamar: true, lamaran: true, saya: true,
  kami: true, anda: true, untuk: true, dengan: true, dari: true, yang: true, dan: true,
  adalah: true, serta: true, pernah: true, melakukan: true, mengelola: true, mengembangkan: true,
  membuat: true, meningkatkan: true, membantu: true, lulusan: true, kerja: true,
  perusahaan: true, universitas: true, sarjana: true, pelanggan: true, berhasil: true,
  menyusun: true, membangun: true, mengoptimalkan: true,
};

type ParsedClaim = z.infer<typeof CLAIM_INPUT>;
type ParsedLetterParagraph = z.infer<typeof MATERIAL_INPUT>['letter']['paragraphs'][number];
type EvidenceReference = { factId: string; sourceId: string; sourceName: string; sourceHash: string; quote: string };
type PreparedClaim = { section: string; text: string; factRefs: EvidenceReference[] };

function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

function tokenSimilarity(left: string, right: string): number {
  const a = new Set(normalizeIdentity(left).split(' ').filter(Boolean));
  const b = new Set(normalizeIdentity(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  url.searchParams.sort();
  return url.toString();
}
function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function assertNoVacancyDuplicate(ws: Workspace, input: z.infer<typeof VACANCY_INPUT>): Vacancy[] {
  const current = ws.store.list<Vacancy>('vacancies');
  const portalDuplicate = input.portalId === undefined
    ? undefined
    : current.find(existing => existing.portalId === input.portalId);
  let urlDuplicate: Vacancy | undefined;
  if (!portalDuplicate && input.url) {
    const targetUrl = normalizedUrl(input.url);
    urlDuplicate = current.find(existing => {
      if (!existing.url) return false;
      try {
        return normalizedUrl(existing.url) === targetUrl;
      } catch {
        return false;
      }
    });
  }
  const duplicate = portalDuplicate ?? urlDuplicate;
  if (duplicate) {
    const key = portalDuplicate ? `portal ID “${input.portalId}”` : `URL “${input.url}”`;
    throw new Error(`Duplicate vacancy for ${key}; existing record ${duplicate.id} was left unchanged.`);
  }
  return current;
}

async function fetchVacancyPage(value: string): Promise<{ mime: string; body: Buffer }> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) {
    throw new Error('URL-only capture accepts public HTTPS on port 443 without credentials. Paste the vacancy text instead.');
  }

  let addresses;
  try {
    addresses = await lookupDns(url.hostname, { all: true, order: 'verbatim' });
  } catch (error) {
    throw new Error('The URL hostname could not be resolved safely. Paste the vacancy text instead.', { cause: error });
  }
  const publicAddress = addresses.find(address => address.family === 4 && isPublicIpv4(address.address));
  if (!publicAddress) throw new Error('No safe public IPv4 address was found (IPv6-only and private addresses are not supported). Paste the vacancy text instead.');

  const agent = new Agent({
    keepAlive: false,
    lookup: (hostname, _options, callback) => {
      if (hostname.toLowerCase() !== url.hostname.toLowerCase()) {
        callback(new Error('The URL request attempted an unexpected hostname.'), '', 4);
        return;
      }
      callback(null, publicAddress.address, 4);
    },
  });
  try {
    return await new Promise((resolvePage, rejectPage) => {
      const request = httpsRequest(url, {
        agent,
        family: 4,
        method: 'GET',
        headers: {
          accept: 'text/html, application/xhtml+xml, text/plain',
          'accept-encoding': 'identity',
          'user-agent': 'Jose-Local-Workspace',
        },
      }, response => {
        if (response.statusCode !== 200) {
          response.resume();
          rejectPage(new Error(`The job page returned HTTP ${response.statusCode ?? 'unknown'}; redirects are not followed. Paste the vacancy text instead.`));
          return;
        }
        const contentType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
        if (!contentType || !['text/html', 'application/xhtml+xml', 'text/plain'].includes(contentType)) {
          response.resume();
          rejectPage(new Error('The URL did not return readable HTML or plain text. Paste the vacancy text instead.'));
          return;
        }
        const encoding = response.headers['content-encoding'];
        if (encoding && encoding.toLowerCase() !== 'identity') {
          response.resume();
          rejectPage(new Error('Compressed job pages are not accepted by safe URL capture. Paste the vacancy text instead.'));
          return;
        }
        const length = Number(response.headers['content-length']);
        if (Number.isFinite(length) && length > MAX_VACANCY_RESPONSE_BYTES) {
          response.resume();
          rejectPage(new Error('The job page exceeds the 2 MB limit. Paste the vacancy text instead.'));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_VACANCY_RESPONSE_BYTES) {
            const error = new Error('The job page exceeds the 2 MB limit. Paste the vacancy text instead.');
            response.destroy(error);
            rejectPage(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolvePage({ mime: contentType, body: Buffer.concat(chunks) }));
        response.on('error', rejectPage);
      });
      request.setTimeout(15_000, () => request.destroy(new Error('The job page request timed out. Paste the vacancy text instead.')));
      request.on('error', rejectPage);
      request.end();
    });
  } finally {
    agent.destroy();
  }
}

async function fetchVacancyText(value: string): Promise<string> {
  try {
    const response = await fetchVacancyPage(value);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
    if (response.mime === 'text/plain') return FETCHED_VACANCY_TEXT.parse(decoded);

    const browser = await launchChromium();
    try {
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
      await context.route('**/*', route => route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.setContent(decoded.replace(/<meta\b[^>]*>/giu, ''), { waitUntil: 'domcontentloaded', timeout: 10_000 });
      return FETCHED_VACANCY_TEXT.parse(await page.locator('body').innerText());
    } finally {
      await browser.close();
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Paste the vacancy text instead.')) throw error;
    throw new Error('Could not safely extract vacancy text from the supplied URL. No redirects, scripts, or linked resources were followed. Paste the vacancy text instead.', { cause: error });
  }
}


export async function captureVacancy(ws: Workspace, input: unknown): Promise<Vacancy> {
  const parsed = VACANCY_INPUT.parse(input);
  assertNoVacancyDuplicate(ws, parsed);
  let vacancyText = parsed.text;
  if (!vacancyText && parsed.url) vacancyText = await fetchVacancyText(parsed.url);
  if (!vacancyText) throw new Error('Provide pasted vacancy text or a user-provided URL.');

  const createdAt = now();
  const vacancy: Vacancy = {
    id: id(),
    company: parsed.company,
    role: parsed.role,
    text: vacancyText,
    ...(parsed.url ? { url: parsed.url } : {}),
    ...(parsed.portalId ? { portalId: parsed.portalId } : {}),
    capturedAt: createdAt,
    lifecycle: 'unknown',
    notes: parsed.notes ?? '',
    possibleDuplicates: [],
  };

  return ws.store.tx(() => {
    const current = assertNoVacancyDuplicate(ws, parsed);
    // ponytail: token overlap can flag generic names; keep warning-only and use reviewed matching if false positives matter.
    vacancy.possibleDuplicates = current
      .filter(existing => tokenSimilarity(existing.company, vacancy.company) >= 0.8 && tokenSimilarity(existing.role, vacancy.role) >= 0.65)
      .map(existing => existing.id);
    ws.store.create<Vacancy>('vacancies', vacancy);
    ws.store.event('vacancy_captured', vacancy.id, {
      portalId: vacancy.portalId ?? null,
      possibleDuplicates: vacancy.possibleDuplicates,
    });
    return vacancy;
  });
}

function isSubmitted(attempt: Attempt): boolean {
  return Boolean(attempt.dateApplied) || SUBMITTED_STATUS[attempt.status.trim().toLowerCase()] === true;
}

function currentProfile(ws: Workspace): Profile {
  const settings = ws.settings();
  if (settings.onboarding !== 'ready' || !settings.profileId) throw new Error('A confirmed profile is required before creating application materials.');
  const profile = ws.store.require<Profile>('profiles', settings.profileId);
  if (!profile.confirmedAt || profile.facts.length === 0 || !profile.facts.some(fact => fact.confirmed)) {
    throw new Error('At least one career fact must be individually confirmed before drafting.');
  }
  return { ...profile, facts: profile.facts.filter(fact => fact.confirmed) };
}

function currentSource(ws: Workspace, sourceId: string): Source {
  const source = ws.store.require<Source>('sources', sourceId);
  if (hash(ws.read(source.path)) !== source.hash) throw new Error(`Imported source changed after capture: ${source.name}.`);
  return source;
}

function prepareReferences(ws: Workspace, refs: z.infer<typeof FACT_REF_INPUT>[], facts: Map<string, Fact>, sourceHashes: Map<string, string>): EvidenceReference[] {
  return refs.map(ref => {
    const fact = facts.get(ref.factId);
    if (!fact || !fact.confirmed) throw new Error(`Fact reference ${ref.factId} is not part of the current confirmed profile.`);
    if (!fact.excerpt.includes(ref.quote)) throw new Error(`Quote for fact ${ref.factId} is not contained in its confirmed source excerpt.`);
    const source = currentSource(ws, fact.sourceId);
    if (!source.text.includes(fact.excerpt)) throw new Error(`Confirmed excerpt for fact ${fact.id} no longer matches ${source.name}.`);
    sourceHashes.set(source.id, source.hash);
    return { factId: fact.id, sourceId: source.id, sourceName: source.name, sourceHash: source.hash, quote: ref.quote };
  });
}

function flaggedBahasaTerms(values: string[]): string[] {
  const found = new Set<string>();
  for (const value of values) {
    for (const word of value.match(/\p{L}+/gu) ?? []) {
      const term = word.toLowerCase();
      // Lowercase-only screening avoids treating an explicitly capitalized proper noun as a language signal.
      if (word === term && BAHASA_MARKERS[term] === true) found.add(term);
    }
  }
  return [...found].sort();
}

function normalizedPdfText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}
async function generateResumeDocx(name:string,title:string,claims:PreparedClaim[],resumeFormat:'bullet'|'paragraph'):Promise<Buffer> {
  const children:Paragraph[]=[
    new Paragraph({children:[new TextRun({text:name,font:'Arial',size:32,bold:true})],spacing:{after:100}}),
    new Paragraph({children:[new TextRun({text:title,font:'Arial',size:22})],spacing:{after:180}}),
  ];
  const sections=new Map<string,string[]>();
  for(const claim of claims){const group=sections.get(claim.section)??[];group.push(claim.text);sections.set(claim.section,group);}
  for(const [section,items] of sections) {
    children.push(new Paragraph({children:[new TextRun({text:section.toUpperCase(),font:'Arial',size:22,bold:true})],heading:HeadingLevel.HEADING_1,spacing:{before:160,after:80}}));
    for(const item of items) {
      const text=new TextRun({text:item,font:'Arial',size:20});
      children.push(resumeFormat==='bullet'
        ?new Paragraph({children:[text],bullet:{level:0},spacing:{after:80}})
        :new Paragraph({children:[text],spacing:{after:100}}));
    }
  }
  const document=new Document({creator:'Jose local workspace',title,sections:[{
    properties:{page:{size:{width:convertMillimetersToTwip(210),height:convertMillimetersToTwip(297)},margin:{top:convertInchesToTwip(0.75),right:convertInchesToTwip(0.75),bottom:convertInchesToTwip(0.75),left:convertInchesToTwip(0.75)}}},
    children,
  }]});
  return Buffer.from(await Packer.toBuffer(document));
}

const EDITED_DOCX_PDF_NOTE='The DOCX file is preserved exactly; the generated PDF uses an ATS-conscious rendering of its text and structure, so custom Word styling and embedded images may not carry over.';
type EditedDocxContent={text:string;html:string;warnings:string[]};
async function readEditedDocx(bytes:Buffer):Promise<EditedDocxContent> {
  const convertImage=mammoth.images.imgElement(async()=>({src:'data:,'}));
  const [raw,converted]=await Promise.all([
    mammoth.extractRawText({buffer:bytes}),
    mammoth.convertToHtml({buffer:bytes},{includeEmbeddedStyleMap:false,externalFileAccess:false,convertImage}),
  ]);
  const errors=[...raw.messages,...converted.messages].filter(message=>message.type==='error');
  if(errors.length)throw new Error(`Edited DOCX could not be read: ${errors.map(message=>message.message).join('; ')}`);
  const text=raw.value.trim();
  if(!text||text.length>1_000_000)throw new Error('Edited DOCX must contain readable text under 1,000,000 characters.');
  return {text,html:converted.value,warnings:converted.messages.filter(message=>message.type==='warning').map(message=>message.message)};
}


async function launchChromium(): Promise<Browser> {
  const { bundledPath, systemPath } = findChromiumRuntime();
  if (!bundledPath && !systemPath) throw new Error('No Chromium executable is available. Install Playwright Chromium or a system Chrome/Edge browser.');
  const launch = (executablePath?: string): Promise<Browser> => chromium.launch(executablePath ? { executablePath } : {});
  try {
    return await launch(bundledPath ? undefined : systemPath);
  } catch (error) {
    if (bundledPath && systemPath) {
      try {
        return await launch(systemPath);
      } catch (fallbackError) {
        throw new Error('Playwright Chromium and the available system browser could not be launched.', { cause: fallbackError });
      }
    }
    throw new Error('The available Chromium executable could not be launched.', { cause: error });
  }
}

function ensureEvidenceRevision(ws: Workspace, material: Material): void {
  const profileHash = material.profileHash;
  const sourceHashes = material.sourceHashes;
  if (typeof profileHash !== 'string' || !sourceHashes || typeof sourceHashes !== 'object' || Array.isArray(sourceHashes)) {
    throw new Error('Material is missing its source/profile revision evidence.');
  }
  const profile = ws.store.require<Profile>('profiles', material.profileId);
  if (hash(stable({ ...profile, facts: profile.facts.filter(fact => fact.confirmed) })) !== profileHash) throw new Error('The confirmed profile facts changed after this material was drafted. Create a new material for the current profile.');
  const parsedSourceHashes = Object.entries(sourceHashes);
  if (!parsedSourceHashes.length || parsedSourceHashes.some(([, value]) => typeof value !== 'string')) {
    throw new Error('Material source revision evidence is invalid.');
  }
  for (const [sourceId, expectedHash] of parsedSourceHashes) {
    const source = currentSource(ws, sourceId);
    if (source.hash !== expectedHash) throw new Error(`Source revision changed after drafting: ${source.name}. Create a new profile and material.`);
  }
  const evidenceValue: unknown = JSON.parse(ws.read(material.files.evidence).toString('utf8'));
  if (!evidenceValue || typeof evidenceValue !== 'object' || Array.isArray(evidenceValue)) throw new Error('Material evidence is malformed.');
  const evidence = evidenceValue as Record<string, unknown>;
  if (evidence.profileHash !== profileHash || stable(evidence.sourceHashes) !== stable(sourceHashes)) {
    throw new Error('Material evidence does not match the saved source/profile revision.');
  }
}

export async function createMaterial(ws: Workspace, input: unknown): Promise<Material> {
  const parsed = MATERIAL_INPUT.parse(input);
  const settings=ws.settings();
  const profile = currentProfile(ws);
  const vacancy = ws.store.require<Vacancy>('vacancies', parsed.vacancyId);
  const initialAttempt = parsed.attemptId ? ws.store.require<Attempt>('attempts', parsed.attemptId) : null;
  if (initialAttempt && initialAttempt.vacancyId !== vacancy.id) throw new Error('The selected attempt belongs to a different vacancy.');
  if (initialAttempt && isSubmitted(initialAttempt)) throw new Error('This application has already been reported or submitted. Create a new attempt instead of revising its materials.');
  const previousMaterial=initialAttempt?.materialId?ws.store.require<Material>('materials',initialAttempt.materialId):null;
  const editingMode=parsed.editedDocxFile?'self_edit':settings.editingMode;
  const resumeFormat=parsed.resumeFormat??(parsed.editedDocxFile?previousMaterial?.resumeFormat:undefined)??settings.resumeFormat;
  if(!editingMode)throw new Error('Ask the user whether they want to edit a DOCX or have Jose revise in chat, then save editingMode with workflow-preferences.');
  if(!resumeFormat)throw new Error('Show the user bullet-point and paragraph examples made from the same confirmed fact, then save resumeFormat with workflow-preferences.');
  if(parsed.editedDocxFile&&(!previousMaterial||previousMaterial.editingMode!=='self_edit'||!previousMaterial.files.docx))throw new Error('An edited DOCX can only revise the current self-edit material on an unsubmitted attempt.');

  const factMap = new Map(profile.facts.map(fact => [fact.id, fact]));
  const sourceHashes = new Map<string, string>();
  const claims: PreparedClaim[] = parsed.claims.map((claim: ParsedClaim) => ({
    section: claim.section,
    text: claim.text,
    factRefs: prepareReferences(ws, claim.factRefs, factMap, sourceHashes),
  }));
  const letterParagraphs: Array<{ text: string; factRefs: EvidenceReference[] }> = parsed.letter.paragraphs.map((paragraph: ParsedLetterParagraph) => ({
    text: paragraph.text,
    factRefs: prepareReferences(ws, paragraph.factRefs, factMap, sourceHashes),
  }));
  const letterLanguage=parsed.letter.language??'en';
  const cvText=[parsed.title,...claims.flatMap(claim=>[claim.section,claim.text])];
  const letterTextForScreen=[parsed.letter.greeting??'',...letterParagraphs.map(paragraph=>paragraph.text),parsed.letter.closing??''];
  const cvFlaggedTerms=flaggedBahasaTerms(cvText);
  const letterFlaggedTerms=letterLanguage==='en'?flaggedBahasaTerms(letterTextForScreen):[];
  const flaggedTerms=[...new Set([...cvFlaggedTerms,...letterFlaggedTerms])].sort();

  let docxBytes:Buffer|undefined;
  let editedDocx:EditedDocxContent|undefined;
  if(parsed.editedDocxFile) {
    if(!parsed.editedDocxHash)throw new Error('Inspect the edited DOCX first and pass its editedDocxHash.');
    docxBytes=ws.read(parsed.editedDocxFile);
    if(docxBytes.length===0||docxBytes.length>20*1024*1024)throw new Error('Edited DOCX must contain 1 byte to 20 MB.');
    if(hash(docxBytes)!==parsed.editedDocxHash)throw new Error('Edited DOCX changed after inspection. Inspect it again before creating a new material revision.');
    editedDocx=await readEditedDocx(docxBytes);
    const normalizedDocx=normalizedPdfText(editedDocx.text);
    for(const requiredText of [profile.name,parsed.title,...claims.map(claim=>claim.text)]) {
      if(!normalizedDocx.includes(normalizedPdfText(requiredText)))throw new Error('The edited DOCX does not contain all source-backed resume claims in the new revision.');
    }
  }

  const attemptId = initialAttempt?.id ?? id();
  const materialId = id();
  const createdAt = now();
  const sourceHashRecord = Object.fromEntries([...sourceHashes.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const profileHash = hash(stable(profile));
  const templatePath = resolve(INSTALL_ROOT, 'templates', 'cv.html');
  const template = await readFile(templatePath, 'utf8');
  const sectionGroups = new Map<string, string[]>();
  for (const claim of claims) {
    const group = sectionGroups.get(claim.section) ?? [];
    group.push(claim.text);
    sectionGroups.set(claim.section, group);
  }
  const sectionHtml = [...sectionGroups.entries()].map(([section, entries]) => {
    const claimsHtml=resumeFormat==='bullet'
      ?`<ul class="resume-bullets">${entries.map(entry=>`<li class="claim">${escapeHtml(entry)}</li>`).join('\n')}</ul>`
      :entries.map(entry=>`<p class="claim">${escapeHtml(entry)}</p>`).join('\n');
    return `<section><h2>${escapeHtml(section)}</h2>${claimsHtml}</section>`;
  }).join('\n');
  const standardContent=`<header><h1>${escapeHtml(profile.name)}</h1><p class="headline">${escapeHtml(parsed.title)}</p></header><main>${sectionHtml}</main>`;
  const resumeContent=editedDocx?`<main class="docx-content">${editedDocx.html}</main>`:standardContent;
  if(template.split('{{CONTENT}}').length!==2)throw new Error('CV template must contain exactly one {{CONTENT}} marker.');
  const html=template.replace('{{CONTENT}}',resumeContent);
  if(editingMode==='self_edit'&&!docxBytes)docxBytes=await generateResumeDocx(profile.name,parsed.title,claims,resumeFormat);

  const letterText = [parsed.letter.greeting, ...letterParagraphs.map(paragraph => paragraph.text), parsed.letter.closing]
    .filter((part): part is string => Boolean(part))
    .join('\n\n') + '\n';
  const evidence = {
    schemaVersion: 3,
    materialId,
    attemptId,
    vacancyId: vacancy.id,
    profileId: profile.id,
    profileHash,
    editingMode,
    resumeFormat,
    sourceHashes: sourceHashRecord,
    language: {
      cv: 'en',
      letter: letterLanguage,
      cvFlaggedTerms,
      letterFlaggedTerms,
      screen: 'common-lowercase-Bahasa-Indonesia-terms',
      fullNaturalLanguageDetection: false,
    },
    claims,
    letter: {
      greeting: parsed.letter.greeting ?? null,
      language: letterLanguage,
      paragraphs: letterParagraphs,
      closing: parsed.letter.closing ?? null,
    },
    ...(editedDocx?{editedDocxText:editedDocx.text,docxConversionWarnings:editedDocx.warnings,pdfRenderingNote:EDITED_DOCX_PDF_NOTE}:{}),
    reviewNote: 'Fact IDs and verbatim quotes provide traceability, not semantic proof. The user must review every claim in chat before approval.',
  };
  const evidenceBytes = Buffer.from(JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  const files:Material['files']={
    html:`applications/${attemptId}/${materialId}/resume.html`,
    pdf:`applications/${attemptId}/${materialId}/resume.pdf`,
    letter:`applications/${attemptId}/${materialId}/cover-letter.txt`,
    evidence:`applications/${attemptId}/${materialId}/evidence.json`,
    ...(docxBytes?{docx:`applications/${attemptId}/${materialId}/resume.docx`}:{}),
  };
  const reviewFiles=Object.fromEntries(Object.entries(files).filter(([kind])=>editingMode!=='self_edit'||kind!=='html'));

  let browser: Browser | undefined;
  let pdfBytes: Uint8Array;
  try {
    browser = await launchChromium();
    const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
    await context.route('**/*',route=>route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const renderedPdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', right: '16mm', bottom: '16mm', left: '16mm' },
    });
    const pdf = await PDFDocument.load(renderedPdf, { throwOnInvalidObject: true });
    pdf.setTitle(parsed.title);
    pdf.setAuthor(profile.name);
    pdf.setSubject(`${vacancy.role} — ${vacancy.company}`);
    pdf.setCreator('Jose local workspace');
    pdf.setProducer('pdf-lib');
    pdf.setCreationDate(new Date(createdAt));
    pdf.setModificationDate(new Date(createdAt));
    pdfBytes = await pdf.save();
  } catch (error) {
    throw new Error('Could not render the CV as a printable PDF. Ensure Chromium can launch and the HTML is valid.', { cause: error });
  } finally {
    await browser?.close();
  }

  const extractedPdf = await extractPdfText(pdfBytes);
  const extractedNormalized = normalizedPdfText(extractedPdf);
  const requiredPdfText=editedDocx
    ?editedDocx.text.split(/\r?\n/u).map(line=>line.trim()).filter(Boolean)
    :[profile.name,parsed.title,...claims.map(claim=>claim.text)];
  for (const requiredText of requiredPdfText) {
    if (!extractedNormalized.includes(normalizedPdfText(requiredText))) {
      throw new Error('The generated PDF did not preserve all expected CV text when read back. The material was not saved.');
    }
  }
  if(docxBytes) {
    const extractedDocx=editedDocx?.text??(await mammoth.extractRawText({buffer:docxBytes})).value;
    const normalizedDocx=normalizedPdfText(extractedDocx);
    for(const requiredText of [profile.name,parsed.title,...claims.map(claim=>claim.text)]) {
      if(!normalizedDocx.includes(normalizedPdfText(requiredText)))throw new Error('The generated DOCX did not preserve all expected CV text. The material was not saved.');
    }
  }

  if (hash(stable(currentProfile(ws))) !== profileHash) throw new Error('The confirmed profile changed while the material was being generated. Start a fresh draft.');
  for (const [sourceId, expectedHash] of Object.entries(sourceHashRecord)) {
    if (currentSource(ws, sourceId).hash !== expectedHash) throw new Error('A referenced source changed while the material was being generated. Start a fresh draft.');
  }

  const attempt: Attempt = initialAttempt
    ? { ...initialAttempt, materialId, status: 'draft' }
    : { id: attemptId, vacancyId: vacancy.id, createdAt, status: 'draft', materialId };
  const bytesByPath: Record<string, Uint8Array> = {
    [files.html]: Buffer.from(html, 'utf8'),
    [files.pdf]: pdfBytes,
    [files.letter]: Buffer.from(letterText, 'utf8'),
    [files.evidence]: evidenceBytes,
  };
  if(docxBytes&&files.docx)bytesByPath[files.docx]=docxBytes;
  const fileHashes = Object.fromEntries(Object.entries(bytesByPath).map(([path, bytes]) => [path, hash(bytes)]));
  const material: Material = {
    id: materialId,
    attemptId,
    vacancyId: vacancy.id,
    profileId: profile.id,
    language: 'en',
    letterLanguage,
    editingMode,
    resumeFormat,
    createdAt,
    files,
    fileHashes,
    manifestHash: '',
    title: parsed.title,
    ...(flaggedTerms.length ? {languageTerms:flaggedTerms,languageWarning:`Review whether these terms are part of an official name or need English translation: ${flaggedTerms.join(', ')}.`} : {}),
    profileHash,
    sourceHashes: sourceHashRecord,
  };
  material.manifestHash=materialManifestHash(material);

  const materialDirectory=ws.path(`applications/${attemptId}/${materialId}`);
  mkdirSync(dirname(materialDirectory),{recursive:true,mode:0o700});
  mkdirSync(materialDirectory,{mode:0o700});
  try {
    for (const [path, bytes] of Object.entries(bytesByPath)) ws.write(path, bytes);
    ws.store.tx(() => {
      const current = initialAttempt ? ws.store.require<Attempt>('attempts', attemptId) : null;
      if (current && (current.materialId !== initialAttempt?.materialId || isSubmitted(current))) {
        throw new Error('The application changed while the material was being generated. Start a fresh draft.');
      }
      if (!current) ws.store.create<Attempt>('attempts', attempt);
      else ws.store.put<Attempt>('attempts', attempt);
      ws.store.create<Material>('materials', material);
      ws.store.event('material_created', material.id, {
        attemptId,
        vacancyId: vacancy.id,
        profileId: profile.id,
        manifestHash: material.manifestHash,
      });
      requestApproval(ws, 'content', material.id, bindingFor(ws, 'content', material.id), {
        title: material.title,
        vacancy: { company: vacancy.company, role: vacancy.role, url: vacancy.url ?? null },
        language: 'en',
        languageCheck: 'Declared English; limited common-term screening only, not full language detection.',
        editingMode,
        resumeFormat,
        files:reviewFiles,
        claims,
        letter: evidence.letter,
        ...(editedDocx?{resumeText:editedDocx.text,docxConversionWarnings:editedDocx.warnings,pdfRenderingNote:EDITED_DOCX_PDF_NOTE}:{}),
        reviewNote: evidence.reviewNote,
      }, attemptId);
    });
  } catch (error) {
    try { rmSync(materialDirectory,{recursive:true,force:true}); } catch { /* preserve the original failure */ }
    throw error;
  }
  return material;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function writeExclusiveAtomic(path: string, data: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${id()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, data);
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(descriptor);
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`Refusing to overwrite an existing file: ${path}`, { cause: error });
    }
    throw error;
  } finally {
    unlinkSync(temporary);
  }
}

export async function exportMaterial(ws: Workspace, materialId: string, outDir: string): Promise<Record<string, unknown>> {
  const parsed = EXPORT_INPUT.parse({ materialId, outDir });
  const material = verifyMaterial(ws, parsed.materialId);
  if (!material.approvedAt) throw new Error('This material has not been approved in chat. Re-read the draft and request approval before exporting.');
  ensureEvidenceRevision(ws, material);
  const attempt = ws.store.require<Attempt>('attempts', material.attemptId);
  if (attempt.vacancyId !== material.vacancyId || attempt.materialId !== material.id) throw new Error('The selected material is not the current revision for its vacancy and application.');
  ws.store.require<Vacancy>('vacancies', material.vacancyId);
  authorize(ws, 'content', material.id, bindingFor(ws, 'content', material.id), {
    title: material.title,
    vacancyId: material.vacancyId,
    manifestHash: material.manifestHash,
  }, false, material.attemptId);

  const selected = isAbsolute(parsed.outDir) ? resolve(parsed.outDir) : resolve(ws.root, parsed.outDir);
  const target = assertPrivateRoot(selected);
  if (inside(INSTALL_ROOT, target)) throw new Error('Material exports cannot be written inside the Jose installation.');
  if (pathExists(target) && !statSync(target).isDirectory()) throw new Error('The selected export path is not a directory.');

  const exportNames:Record<string,string>={...(material.editingMode==='self_edit'?{}:{html:'resume.html'}),pdf:'resume.pdf',letter:'cover-letter.txt',evidence:'evidence.json',...(material.files.docx?{docx:'resume.docx'}:{})};
  const exportEntries=Object.entries(material.files).filter(([kind])=>material.editingMode!=='self_edit'||kind!=='html');
  const exportItems=exportEntries.map(([kind,sourcePath])=>{
    const fileName=exportNames[kind];
    if(!fileName)throw new Error(`Unsupported material file: ${kind}`);
    const sourceBytes=ws.read(sourcePath);
    if(hash(sourceBytes)!==material.fileHashes[sourcePath])throw new Error(`Material file changed after approval: ${sourcePath}.`);
    const destination=resolve(target,fileName);
    if(!inside(target,destination))throw new Error('Export file path escapes the selected private output directory.');
    if(pathExists(destination))throw new Error(`Refusing to overwrite an existing file: ${destination}`);
    return {kind,sourceBytes,destination};
  });
  const exported: Record<string, string> = {};
  for (const { kind, sourceBytes, destination } of exportItems) {
    writeExclusiveAtomic(destination, sourceBytes);
    exported[kind] = destination;
  }
  return {
    materialId: material.id,
    attemptId: material.attemptId,
    vacancyId: material.vacancyId,
    outputDirectory: target,
    files: exported,
    fileHashes: material.fileHashes,
    manifestHash: material.manifestHash,
  };
}
export async function inspectEditedDocx(ws:Workspace,materialId:string,filePath?:string):Promise<Record<string,unknown>> {
  const material=ws.store.require<Material>('materials',materialId);
  if(material.editingMode!=='self_edit'||!material.files.docx)throw new Error('This material has no self-edit DOCX. Choose self-edit mode before creating the draft.');
  const attempt=ws.store.require<Attempt>('attempts',material.attemptId);
  if(attempt.materialId!==material.id||isSubmitted(attempt))throw new Error('Only the current unsubmitted material can be inspected for edits.');
  if(materialManifestHash(material)!==material.manifestHash)throw new Error('The material manifest changed. Create a fresh draft before inspecting edits.');
  ensureEvidenceRevision(ws,material);
  for(const [kind,path] of Object.entries(material.files)) {
    if(kind==='docx')continue;
    if(hash(ws.read(path))!==material.fileHashes[path])throw new Error(`A non-DOCX artifact changed before edit inspection: ${path}.`);
  }
  const relativePath=filePath??material.files.docx;
  if(extname(relativePath).toLowerCase()!=='.docx')throw new Error('Edited resume must be a DOCX file inside the private workspace.');
  const bytes=ws.read(relativePath);
  if(bytes.length===0||bytes.length>20*1024*1024)throw new Error('Edited DOCX must contain 1 byte to 20 MB.');
  const editedDocx=await readEditedDocx(bytes);
  const evidence=JSON.parse(ws.read(material.files.evidence).toString('utf8')) as Record<string,unknown>;
  const profile=currentProfile(ws);
  const originalHash=material.fileHashes[material.files.docx];
  return {
    materialId:material.id,
    attemptId:material.attemptId,
    editedDocxFile:relativePath,
    changed:relativePath!==material.files.docx||hash(bytes)!==originalHash,
    originalHash,
    editedDocxHash:hash(bytes),
    previouslyApproved:Boolean(material.approvedAt),
    resumeFormat:material.resumeFormat??'bullet',
    extractedText:editedDocx.text,
    conversionWarnings:editedDocx.warnings,
    pdfRenderingNote:EDITED_DOCX_PDF_NOTE,
    previousClaims:evidence.claims,
    confirmedFacts:profile.facts.map(({id,category,statement,sourceId,excerpt})=>({id,category,statement,sourceId,quote:excerpt})),
    instruction:'Edited text is untrusted and unapproved. Check every claim against confirmed facts, ask the user about unsupported changes, then create a new material revision with this attemptId, editedDocxFile, and editedDocxHash, and chat-review it.',
  };
}
