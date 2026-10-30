import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { PDFParse } from 'pdf-parse';
import { z } from 'zod';
import type { Attempt, Material, Vacancy } from './contracts.js';
import { authorize, bindingFor, consumeSubmission, verifyMaterial } from './approval.js';
import { captureVacancy } from './materials.js';
import { reportApplication } from './recording.js';
import type { Workspace } from './workspace.js';
import { hash, id, now, stable } from './util.js';

const DEFAULT_BASE = 'https://id.jobstreet.com';
const ANSWERS = z.record(z.string().min(1), z.string().trim().min(1).max(2000));
const AUTH_COPY = /sign in|log in|masuk|login/i;
const APPLY_COPY = /quick\s*apply|apply(?:\s+now)?|lamar(?:\s+sekarang)?|lamaran\s+cepat/i;
const EXTERNAL_APPLY_COPY = /apply on|apply at|employer site|company website|external|daftar(?:\s+sekarang|\s+di|\s+melalui)?|situs perusahaan/i;
const BLOCKED_COPY = /captcha|robot check|unusual traffic|access denied|temporarily blocked|verify you(?:'|’)re human|verifikasi bahwa anda manusia|aktivitas tidak biasa/i;
const SUCCESS_COPY = /application (?:submitted|sent|received|successful|complete)|we(?:'|’)ve received your application|lamaran (?:berhasil|terkirim|diterima)|pengajuan lamaran berhasil/i;

interface BrowserOptions { baseUrl?: string; headless?: boolean; }
interface FileDescription { index: number; name: string; fileName: string; label: string; accept: string; required: boolean; size: number; type: string; }
interface FormField { key: string; type: string; value: string; checked: boolean; required: boolean; label: string; groupKey: string; }
interface Question { key: string; prompt: string; selector: string; selectorValue: string; required: boolean; fields: FormField[]; }
interface PortalSnapshot { url: string; fields: FormField[]; files: FileDescription[]; }
interface DisclosureBundle { cvText: string; coverText: string; cvFileName: string; coverFileName: string; cvHash: string; coverHash: string; }
interface FlowState {
  state: 'disclosure_pending' | 'opening_application' | 'answers_required' | 'boost_selected' | 'unsafe_prefill' | 'prepared' | 'reviewed' | 'submitting' | 'submission_uncertain' | 'portal_observed' | 'external_apply' | 'submission_blocked';
  materialId: string;
  attemptId: string;
  vacancyId: string;
  targetUrl: string;
  applyUrl: string;
  disclosureBinding: string;
  disclosureBundle: DisclosureBundle;
  answers: Record<string, string>;
  questions: Question[];
  baselineProfile: FormField[];
  preparedSnapshot?: PortalSnapshot;
  coverTextFilled?: boolean;
  reviewedSnapshot?: PortalSnapshot;
  reviewBinding?: string;
  operationId?: string;
  blockedExternalUrl?: string;
  updatedAt: string;
}

const FlowSchema = z.object({
  state: z.enum(['disclosure_pending', 'opening_application', 'answers_required', 'boost_selected', 'unsafe_prefill', 'prepared', 'reviewed', 'submitting', 'submission_uncertain', 'portal_observed', 'external_apply', 'submission_blocked']),
  materialId: z.string(), attemptId: z.string(), vacancyId: z.string(), targetUrl: z.string(), applyUrl: z.string(), disclosureBinding: z.string(),
  disclosureBundle: z.object({ cvText: z.string(), coverText: z.string(), cvFileName: z.string(), coverFileName: z.string(), cvHash: z.string(), coverHash: z.string() }),
  answers: ANSWERS, questions: z.array(z.object({ key: z.string(), prompt: z.string(), selector: z.string(), selectorValue: z.string(), required: z.boolean(), fields: z.array(z.object({ key: z.string(), type: z.string(), value: z.string(), checked: z.boolean(), required: z.boolean(), label: z.string(), groupKey: z.string() })) })),
  baselineProfile: z.array(z.object({ key: z.string(), type: z.string(), value: z.string(), checked: z.boolean(), required: z.boolean(), label: z.string(), groupKey: z.string() })),
  preparedSnapshot: z.object({ url: z.string(), fields: z.array(z.object({ key: z.string(), type: z.string(), value: z.string(), checked: z.boolean(), required: z.boolean(), label: z.string(), groupKey: z.string() })), files: z.array(z.object({ index: z.number(), name: z.string(), fileName: z.string(), label: z.string(), accept: z.string(), required: z.boolean(), size: z.number(), type: z.string() })) }).optional(),
  reviewedSnapshot: z.object({ url: z.string(), fields: z.array(z.object({ key: z.string(), type: z.string(), value: z.string(), checked: z.boolean(), required: z.boolean(), label: z.string(), groupKey: z.string() })), files: z.array(z.object({ index: z.number(), name: z.string(), fileName: z.string(), label: z.string(), accept: z.string(), required: z.boolean(), size: z.number(), type: z.string() })) }).optional(),
  reviewBinding: z.string().optional(), operationId: z.string().optional(), blockedExternalUrl: z.string().optional(), updatedAt: z.string(),
  coverTextFilled: z.boolean().optional(),
});

function normalizeText(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
function sameText(a: string, b: string): boolean { return normalizeText(a).toLocaleLowerCase() === normalizeText(b).toLocaleLowerCase(); }
function fileName(path: string): string { return basename(path.replace(/\\/g, '/')); }
function displayUrl(value: string): string { const url = new URL(value); url.hash = ''; return url.toString(); }
function normalizeListingUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  url.searchParams.sort();
  return url.toString();
}
function identityFromUrl(value: string): string | undefined {
  const url = new URL(value);
  const match = url.pathname.match(/\/job\/([^/?#]+)/i);
  return match?.[1] ? `jobstreet:${decodeURIComponent(match[1])}` : undefined;
}
function hasNonEmptyValue(field: FormField): boolean {
  if (field.type === 'radio' || field.type === 'checkbox') return field.checked;
  return field.value.trim().length > 0;
}
function stateOf(attempt: Attempt): FlowState | null {
  if (!attempt.jobstreet || typeof attempt.jobstreet !== 'object') return null;
  const parsed = FlowSchema.safeParse(attempt.jobstreet);
  if (!parsed.success) throw new Error('The saved Jobstreet session state is invalid; stop and review the application before continuing.');
  return parsed.data;
}

export class JobstreetSession {
  private readonly baseUrl: string;
  private readonly fixtureMode: boolean;
  private readonly headless: boolean;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private blockedExternalUrl: string | null = null;
  private closed = false;

  constructor(private readonly ws: Workspace, options: BrowserOptions = {}) {
    const base = new URL(options.baseUrl ?? DEFAULT_BASE);
    const production = base.protocol === 'https:' && base.hostname === 'id.jobstreet.com' && base.port === '' && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password;
    const fixture = base.protocol === 'http:' && base.hostname === '127.0.0.1' && !!base.port && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password;
    if (!production && !fixture) throw new Error('Jobstreet baseUrl must be https://id.jobstreet.com or a test-only http://127.0.0.1:<port> fixture.');
    this.baseUrl = base.origin;
    this.fixtureMode = fixture;
    this.headless = fixture ? options.headless ?? true : false;
  }

  private isPortalUrl(value: string): boolean {
    try {
      const url = new URL(value);
      if (this.fixtureMode) return url.origin === this.baseUrl;
      return url.protocol === 'https:' && (url.hostname === 'jobstreet.com' || url.hostname.endsWith('.jobstreet.com')) && url.port === '' && !url.username && !url.password;
    } catch { return false; }
  }

  private async browser(): Promise<{ context: BrowserContext; page: Page }> {
    if (this.closed) throw new Error('This Jobstreet session is closed.');
    if (!this.context) {
      const profileDir = this.ws.path('browser/jobstreet-profile');
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      const bundledExists = existsSync(chromium.executablePath());
      const systemCandidates = process.platform === 'win32'
        ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')]
        : process.platform === 'darwin'
          ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
          : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge'];
      const system = systemCandidates.find(candidate => existsSync(candidate));
      if (!bundledExists && !system) throw new Error('No Chromium executable is available. Install Playwright Chromium or a system Chrome/Edge browser.');
      const launch = (executablePath?: string): Promise<BrowserContext> => chromium.launchPersistentContext(profileDir, { headless: this.headless, acceptDownloads: false, viewport: { width: 1365, height: 900 }, ...(executablePath ? { executablePath } : {}) });
      let context: BrowserContext;
      try { context = await launch(bundledExists ? undefined : system); }
      catch (error) {
        if (!bundledExists || !system) throw new Error('The available Chromium executable could not be launched.', { cause: error });
        try { context = await launch(system); }
        catch (fallbackError) { throw new Error('Playwright Chromium and the available system browser could not be launched.', { cause: fallbackError }); }
      }
      this.context = context;
      await context.route('**/*', async route => {
        const request = route.request();
        const requestUrl = request.url();
        if (this.isPortalUrl(requestUrl) || requestUrl.startsWith('about:') || requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) {
          await route.continue();
          return;
        }
        const staticGet = request.method() === 'GET' && ['image', 'stylesheet', 'font', 'script', 'media'].includes(request.resourceType());
        if (staticGet && !request.isNavigationRequest()) {
          await route.continue();
          return;
        }
        if (request.isNavigationRequest() || request.method() !== 'GET') this.blockedExternalUrl = requestUrl;
        await route.abort();
      });
      context.on('close', () => { this.context = null; this.page = null; });
    }
    const context = this.context;
    if (!context) throw new Error('Jobstreet browser context was closed.');
    if (!this.page || this.page.isClosed()) this.page = context.pages()[0] ?? await context.newPage();
    return { context, page: this.page };
  }

  private async go(page: Page, url: string): Promise<{ status?: number; redirectedUrl: string }> {
    if (!this.isPortalUrl(url)) throw new Error('The requested target is not on the configured Jobstreet host.');
    this.blockedExternalUrl = null;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { ...(response ? { status: response.status() } : {}), redirectedUrl: page.url() };
  }

  private async bodyText(page: Page): Promise<string> {
    return normalizeText((await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')));
  }

  private async gate(page: Page, httpStatus?: number): Promise<'blocked' | 'login_required' | null> {
    const text = await this.bodyText(page);
    if ((httpStatus !== undefined && [401, 403, 429].includes(httpStatus)) || BLOCKED_COPY.test(text) || await page.locator('iframe[src*="captcha" i], [data-captcha], [data-testid*="captcha" i], input[name*="captcha" i]').count() > 0) return 'blocked';
    const loginLink = page.getByRole('link', { name: AUTH_COPY }).first();
    if (await loginLink.isVisible().catch(() => false) || /\/(?:login|signin|sign-in)(?:\/|\?|$)/i.test(page.url())) return 'login_required';
    return null;
  }

  async login(): Promise<Record<string, unknown>> {
    const { page } = await this.browser();
    const result = await this.go(page, this.baseUrl);
    const gated = await this.gate(page, result.status);
    if (gated === 'blocked') return { state: 'blocked', url: page.url(), message: 'Jobstreet is presenting a CAPTCHA, access block, or verification challenge. Complete it manually in the visible browser; automation will not bypass it.' };
    const authenticated = await page.locator('[data-authenticated="true"], [data-testid="member-profile"], a[href*="logout" i], a[href*="signout" i]').count() > 0 || /log out|sign out|keluar/i.test(await this.bodyText(page));
    return { state: authenticated ? 'authenticated' : gated === 'login_required' ? 'login_required' : 'manual_login', url: page.url(), message: authenticated ? 'The visible Jobstreet session appears signed in.' : 'Sign in manually in this visible private browser. Handle CAPTCHA, OTP, and verification yourself, then call login again.' };
  }

  private async listingCards(page: Page): Promise<Array<{ href: string; title: string; preview: string; portalId?: string }>> {
    return page.locator('a[href*="/job/"]').evaluateAll(links => links.flatMap(node => {
      const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();
      const anchor = node as HTMLAnchorElement;
      const card = anchor.closest('[data-job-card], article, [data-testid*="saved-job" i], [data-testid*="job-card" i]') ?? anchor.parentElement?.parentElement;
      if (!card) return [];
      const title = clean(anchor.innerText || anchor.getAttribute('aria-label') || '');
      const href = anchor.href;
      if (!title || !href) return [];
      const portalId = card.getAttribute('data-job-id') ?? anchor.getAttribute('data-job-id') ?? undefined;
      return [{ href, title, preview: clean(card.textContent ?? ''), ...(portalId ? { portalId } : {}) }];
    }));
  }

  private async detail(page: Page): Promise<{ role: string; company: string; text: string; url: string; portalId?: string } | null> {
    const role = normalizeText(await page.locator('[data-automation="job-detail-title"], h1').first().innerText().catch(() => ''));
    const company = normalizeText(await page.locator('[data-testid*="advertiser" i], [data-testid*="company" i], [data-automation="advertiser-name"], [data-automation*="company" i], [itemprop="hiringOrganization"]').first().innerText().catch(() => ''));
    const specificBody = page.locator('[data-testid*="job-description" i], [data-automation*="job-description" i], [data-automation="jobAdDetails"], [itemprop="description"]');
    const bodyLocator = await specificBody.count() ? specificBody.first() : page.locator('main article, article').first();
    const body = normalizeText(await bodyLocator.innerText().catch(() => ''));
    const url = displayUrl(page.url());
    const portalId = identityFromUrl(url);
    if (!role || !company || !body) return null;
    return { role, company, text: body, url, ...(portalId ? { portalId } : {}) };
  }

  async scrape(): Promise<Record<string, unknown>> {
    const { context, page } = await this.browser();
    const savedUrl = new URL('/id/my-activity/saved-jobs', this.baseUrl).toString();
    let navigation = await this.go(page, savedUrl);
    let gate = await this.gate(page, navigation.status);
    if (gate) return { state: gate, url: page.url(), message: gate === 'blocked' ? 'Jobstreet blocked automated access or requires a CAPTCHA. No bypass was attempted.' : 'Sign in manually in the visible browser, then scrape again.' };

    const detailPage = await context.newPage();
    const visitedPages = new Set<string>();
    const visitedListings = new Set<string>();
    const created: Vacancy[] = [];
    const duplicates: Array<{ portalId?: string; url: string; vacancyId: string; warning: string }> = [];
    const warnings: string[] = [];
    let pageCount = 0;
    let hasMore = false;
    try {
      while (pageCount < 1000) {
        const currentUrl = displayUrl(page.url());
        if (visitedPages.has(currentUrl)) { warnings.push(`Pagination loop stopped at ${currentUrl}.`); break; }
        visitedPages.add(currentUrl);
        pageCount++;
        const cards = await this.listingCards(page);
        if (cards.length === 0 && pageCount === 1 && AUTH_COPY.test(await this.bodyText(page))) return { state: 'login_required', url: page.url(), message: 'Saved jobs require a signed-in Jobstreet session.' };
        for (const card of cards) {
          const target = displayUrl(new URL(card.href, page.url()).toString());
          if (!this.isPortalUrl(target)) { warnings.push(`Skipped a listing that points outside the configured Jobstreet host: ${target}`); continue; }
          const portalId = card.portalId ? `jobstreet:${card.portalId}` : identityFromUrl(target);
          const listingKey = portalId ?? target;
          if (visitedListings.has(listingKey)) continue;
          visitedListings.add(listingKey);
          const normalizedTarget = normalizeListingUrl(target);
          const identityMatch = (candidate: Vacancy): boolean => {
            if (portalId && candidate.portalId === portalId) return true;
            if (!candidate.url) return false;
            try { return normalizeListingUrl(candidate.url) === normalizedTarget; }
            catch { return false; }
          };
          const existing = this.ws.store.list<Vacancy>('vacancies').find(identityMatch);
          const detailNavigation = await this.go(detailPage, target);
          const detailGate = await this.gate(detailPage, detailNavigation.status);
          if (detailGate) return { state: detailGate, url: detailPage.url(), captured: created.length, warnings, message: 'Jobstreet access is blocked or the signed-in session expired. No further scraping was attempted.' };
          const record = await this.detail(detailPage);
          if (!record) { warnings.push(`Skipped incomplete job detail at ${target}; title, advertiser, or body was missing.`); continue; }
          const resolvedPortalId = portalId ?? record.portalId;
          if (existing) {
            duplicates.push({ ...(resolvedPortalId ? { portalId: resolvedPortalId } : {}), url: target, vacancyId: existing.id, warning: 'This exact Jobstreet listing already exists. The existing vacancy and notes were left unchanged.' });
            continue;
          }
          let createdVacancy: Vacancy;
          try {
            createdVacancy = await captureVacancy(this.ws, { company: record.company, role: record.role, text: record.text, url: record.url, ...(resolvedPortalId ? { portalId: resolvedPortalId } : {}), notes: `Captured from the signed-in Jobstreet saved-jobs list; listing title: ${card.title}` });
          } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('Duplicate vacancy for')) throw error;
            const racedDuplicate = this.ws.store.list<Vacancy>('vacancies').find(identityMatch);
            if (!racedDuplicate) throw error;
            duplicates.push({ ...(resolvedPortalId ? { portalId: resolvedPortalId } : {}), url: target, vacancyId: racedDuplicate.id, warning: 'This exact Jobstreet listing was captured concurrently. The existing vacancy and notes were left unchanged.' });
            continue;
          }
          created.push(createdVacancy);
          for (const possibleId of createdVacancy.possibleDuplicates) warnings.push(`Possible similar vacancy ${possibleId}; no existing vacancy was overwritten.`);
        }
        const next = await page.locator('a[rel="next"], a[aria-label*="next" i], a[aria-label*="selanjutnya" i]').evaluateAll(links => {
          const link = links.find(node => !(node as HTMLAnchorElement).hasAttribute('aria-disabled') && !(node as HTMLAnchorElement).classList.contains('disabled')) as HTMLAnchorElement | undefined;
          return link?.href ?? null;
        });
        if (!next) break;
        const nextUrl = displayUrl(new URL(next, page.url()).toString());
        if (!this.isPortalUrl(nextUrl) || visitedPages.has(nextUrl)) { warnings.push('Saved-job pagination stopped because the next link was outside the current Jobstreet host or repeated a visited page.'); break; }
        navigation = await this.go(page, nextUrl);
        gate = await this.gate(page, navigation.status);
        if (gate) return { state: gate, url: page.url(), captured: created.length, duplicates, warnings, message: 'Jobstreet access changed during pagination; scraping stopped.' };
        hasMore = false;
      }
      if (pageCount === 1000) { hasMore = true; warnings.push('Pagination stopped at the safety limit of 1,000 pages.'); }
      return { state: 'scraped', pages: pageCount, captured: created, duplicates, warnings, hasMore };
    } finally {
      if (!detailPage.isClosed()) await detailPage.close().catch(() => undefined);
    }
  }

  private async disclosureBundle(material: Material): Promise<DisclosureBundle> {
    const pdf = new PDFParse({ data: this.ws.read(material.files.pdf) });
    let cvText: string;
    try { cvText = normalizeText((await pdf.getText()).text); }
    finally { await pdf.destroy(); }
    const coverText = normalizeText(this.ws.read(material.files.letter).toString('utf8'));
    if (!cvText || !coverText) throw new Error('The approved CV PDF or cover-letter text is empty or unreadable; no portal transition was made.');
    return { cvText, coverText, cvFileName: fileName(material.files.pdf), coverFileName: fileName(material.files.letter), cvHash: material.fileHashes[material.files.pdf]!, coverHash: material.fileHashes[material.files.letter]! };
  }

  private async applyAction(page: Page): Promise<{ applyUrl: string; externalUrl?: string; linkIndex?: number; buttonName?: string }> {
    const actions = await page.locator('a').evaluateAll(links => links.map((node, index) => {
      const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();
      const link = node as HTMLAnchorElement;
      return { index, href: link.href || '', text: clean(link.innerText || link.getAttribute('aria-label') || '') };
    }));
    const candidates = actions.filter(a => APPLY_COPY.test(a.text) || EXTERNAL_APPLY_COPY.test(a.text));
    const candidate = candidates.find(a => APPLY_COPY.test(a.text)) ?? candidates.find(a => EXTERNAL_APPLY_COPY.test(a.text));
    if (candidate?.href && !candidate.href.endsWith('#')) {
      const href = displayUrl(candidate.href);
      if (!this.isPortalUrl(href)) return { applyUrl: page.url(), externalUrl: href, linkIndex: candidate.index };
      return { applyUrl: href, linkIndex: candidate.index };
    }
    const buttons = await page.getByRole('button').evaluateAll(nodes => nodes.map((node, index) => {
      const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();
      return { index, text: clean((node as HTMLButtonElement).innerText || node.getAttribute('aria-label') || '') };
    }));
    const button = buttons.find(b => APPLY_COPY.test(b.text));
    if (button) return { applyUrl: page.url(), buttonName: button.text };
    return { applyUrl: page.url() };
  }

  private async questions(page: Page): Promise<Question[]> {
    return page.locator('form [data-screening-question], form [data-question-id], form fieldset, form [role="group"], form input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]), form textarea, form select').evaluateAll(nodes => {
      const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();
      const screeningCopy = /screening|question|salary|compensation|expected (?:pay|salary)|experience|notice period|work authori[sz]ation|visa|right to work|are you|do you|how many|what is|declaration|confirm|agree|years? of experience|berapa|gaji|pengalaman|izin kerja|bersedia|kapan mulai|pernyataan|setuju|konfirmasi/i;
      const isControl = (node: Element): node is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement;
      const isGroup = (node: Element): boolean => node.matches('[data-screening-question], [data-question-id], fieldset, [role="group"]');
      const candidates = nodes.filter(node => (isGroup(node) || isControl(node)) && !nodes.some(parent => parent !== node && parent.contains(node) && isGroup(parent)));
      const roots: Array<{ node: Element; controls: Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> }> = [];
      const groupedControls = new Set<Element>();
      for (const node of candidates) {
        if (!isControl(node)) {
          const group = node as HTMLElement;
          const controls = Array.from(group.querySelectorAll('input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]), textarea, select')) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
          if (controls.length) roots.push({ node, controls });
          continue;
        }
        if (groupedControls.has(node)) continue;
        const controls = node instanceof HTMLInputElement && node.name && ['radio', 'checkbox'].includes(node.type.toLowerCase())
          ? candidates.filter((candidate): candidate is HTMLInputElement => isControl(candidate) && candidate instanceof HTMLInputElement && candidate.name === node.name && candidate.type.toLowerCase() === node.type.toLowerCase())
          : [node];
        for (const control of controls) groupedControls.add(control);
        roots.push({ node, controls });
      }
      return roots.flatMap(({ node, controls }, index) => {
        const group = node as HTMLElement;
        const first = controls[0]!;
        const associated = first.labels ? Array.from(first.labels).map(label => clean(label.textContent ?? '')).join(' ') : '';
        const prompt = clean(group.querySelector('legend')?.textContent ?? group.getAttribute('aria-label') ?? group.getAttribute('data-question') ?? '') || associated || clean(first.getAttribute('aria-label') ?? '');
        const marked = group.hasAttribute('data-question-id') ? ['data-question-id', group.getAttribute('data-question-id') ?? ''] as const
          : group.hasAttribute('data-screening-question') ? ['data-screening-question', group.getAttribute('data-screening-question') ?? ''] as const
          : group.id ? ['id', group.id] as const
          : isControl(node) && node.name ? ['control-name', node.name] as const
          : isControl(node) && node.id ? ['control-id', node.id] as const
          : node instanceof HTMLFieldSetElement ? ['fieldset-index', String(Array.from(document.querySelectorAll('form fieldset')).indexOf(node))] as const
          : ['control-index', String(Array.from(document.querySelectorAll('form input:not([type="hidden"]), form textarea, form select')).indexOf(node))] as const;
        const selector = marked[0];
        const selectorValue = marked[1];
        const key = group.getAttribute('data-question-id') || group.getAttribute('data-screening-question') || first.name || first.id || prompt.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `question_${index + 1}`;
        const fields = controls.map((control, fieldIndex) => {
          const type = control instanceof HTMLInputElement ? control.type.toLowerCase() : control instanceof HTMLSelectElement ? 'select' : 'textarea';
          const labels = control.labels ? Array.from(control.labels).map(label => clean(label.textContent ?? '')).join(' ') : '';
          const label = labels || clean(control.getAttribute('aria-label') ?? control.id ?? control.name ?? '');
          const checked = control instanceof HTMLInputElement && (type === 'radio' || type === 'checkbox') ? control.checked : false;
          const fieldKey = control.name || control.id || `${key}_${fieldIndex + 1}`;
          const required = control.required || control.getAttribute('aria-required') === 'true' || group.getAttribute('aria-required') === 'true';
          return { key: fieldKey, type, value: control.value, checked, required, label, groupKey: key };
        });
        const required = fields.some(field => field.required) || group.getAttribute('aria-required') === 'true';
        if (!screeningCopy.test(prompt) && !group.hasAttribute('data-screening-question') && !group.hasAttribute('data-question-id')) return [];
        return [{ key, prompt, selector, selectorValue, required, fields }];
      });
    });
  }

  private questionLocator(page: Page, question: Question): Locator {
    if (question.selector === 'fieldset-index') return page.locator('form fieldset').nth(Number(question.selectorValue));
    if (question.selector === 'control-name') return page.locator(`form [name=${JSON.stringify(question.selectorValue)}]`);
    if (question.selector === 'control-id') return page.locator(`form [id=${JSON.stringify(question.selectorValue)}]`);
    if (question.selector === 'control-index') return page.locator('form input:not([type="hidden"]), form textarea, form select').nth(Number(question.selectorValue));
    return page.locator(`[${question.selector}=${JSON.stringify(question.selectorValue)}]`);
  }

  private async answerQuestion(page: Page, question: Question, answer: string): Promise<void> {
    const group = this.questionLocator(page, question);
    const inputSelector = 'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]), textarea, select';
    const inputs = question.selector.startsWith('control-') ? group : group.locator(inputSelector);
    const types = [...new Set(question.fields.map(field => field.type))];
    if (types.length !== 1) throw new Error(`The screening question “${question.prompt}” uses mixed control types; answer it manually in the visible browser.`);
    const type = types[0];
    if (type === 'radio') {
      const label = group.getByLabel(answer, { exact: true });
      if (await label.count() === 1) { await label.check(); return; }
      const valueOption = inputs.locator(`[value=${JSON.stringify(answer)}]`);
      if (await valueOption.count() === 1) { await valueOption.check(); return; }
      throw new Error(`The answer for “${question.prompt}” must exactly match one visible option.`);
    }
    if (type === 'checkbox') {
      if (question.fields.length !== 1) throw new Error(`The screening question “${question.prompt}” has multiple checkboxes; provide a single explicit portal selection manually.`);
      const normalized = answer.toLocaleLowerCase();
      if (!['yes', 'no', 'true', 'false', '1', '0'].includes(normalized)) throw new Error(`The checkbox answer for “${question.prompt}” must be an explicit yes/no value.`);
      await inputs.first().setChecked(['yes', 'true', '1'].includes(normalized));
      return;
    }
    if (type === 'select') {
      const options = await inputs.first().locator('option').evaluateAll(nodes => nodes.map(node => ({ value: (node as HTMLOptionElement).value, label: ((node as HTMLOptionElement).label || node.textContent || '').replace(/\s+/g, ' ').trim() })));
      const exact = options.find(option => option.value === answer || option.label === answer);
      if (!exact) throw new Error(`The answer for “${question.prompt}” must exactly match a listed option.`);
      if (exact.value) await inputs.first().selectOption(exact.value);
      else await inputs.first().selectOption({ label: exact.label });
      return;
    }
    if (type === 'text' || type === 'textarea' || type === 'number' || type === 'email' || type === 'tel' || type === 'url' || type === 'date') {
      if (question.fields.length !== 1) throw new Error(`The screening question “${question.prompt}” has multiple text fields; answer it manually in the visible browser.`);
      if (type === 'number' && !/^-?\d+(?:\.\d+)?$/.test(answer)) throw new Error(`The answer for “${question.prompt}” must be a valid number.`);
      await inputs.first().fill(answer);
      const valid = await inputs.first().evaluate(node => (node as HTMLInputElement).checkValidity());
      if (!valid) throw new Error(`The answer for “${question.prompt}” does not satisfy the portal field constraints.`);
      return;
    }
    throw new Error(`The screening field for “${question.prompt}” is not supported for safe automatic entry.`);
  }

  private async formFields(page: Page): Promise<FormField[]> {
    return page.locator('form input, form textarea, form select, [role="checkbox"], [role="radio"], button, [role="button"], [data-testid*="primary" i], [data-testid*="visibility" i], [data-testid*="profile" i], [data-automation*="primary" i], [data-automation*="visibility" i], [data-automation*="profile" i], [aria-label*="primary" i], [aria-label*="visibility" i], [aria-label*="profile" i], [aria-label*="resume" i], [aria-label*="cv" i]').evaluateAll(nodes => nodes.flatMap((node, index) => {
      const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();
      const screeningCopy = /screening|question|salary|compensation|expected pay|experience|notice period|work authori[sz]ation|visa|right to work|are you|do you|how many|what is|declaration|confirm|agree|berapa|gaji|pengalaman|izin kerja|bersedia|kapan mulai|pernyataan|setuju|konfirmasi/i;
      const element = node as HTMLElement;
      const control = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element : null;
      const type = control instanceof HTMLInputElement ? control.type.toLowerCase() : control instanceof HTMLSelectElement ? 'select' : control instanceof HTMLTextAreaElement ? 'textarea' : 'state';
      if (['hidden', 'file', 'submit', 'button', 'reset', 'image'].includes(type)) return [];
      const fieldset = element.closest('fieldset');
      const prompt = clean(fieldset?.querySelector('legend')?.textContent ?? '');
      if (element.closest('[data-screening-question], [data-question-id]') || (fieldset && screeningCopy.test(prompt))) return [];
      const labels = control?.labels ? Array.from(control.labels).map(label => clean(label.textContent ?? '')).join(' ') : '';
      const label = labels || clean(element.getAttribute('aria-label') ?? element.getAttribute('data-testid') ?? element.id ?? element.getAttribute('name') ?? '');
      const key = control?.name || control?.id || element.getAttribute('data-testid') || element.id || `${type}_${index}`;
      const checked = control instanceof HTMLInputElement && (type === 'radio' || type === 'checkbox') ? control.checked : element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-pressed') === 'true';
      const value = control?.value ?? element.getAttribute('aria-checked') ?? element.getAttribute('aria-pressed') ?? clean(element.textContent ?? '');
      if (type === 'state' && !/(primary|cv|resume|visibility|profile|include|exclude|jangan sertakan|jadikan|utama|visibilitas|profil)/i.test(`${label} ${value}`)) return [];
      return [{ key, type, value, checked, required: !!control?.required || control?.getAttribute('aria-required') === 'true' || element.getAttribute('aria-required') === 'true', label, groupKey: '' }];
    }));
  }

  private async fileInputs(page: Page): Promise<FileDescription[]> {
    return page.locator('form input[type="file"]').evaluateAll(nodes => nodes.map((node, index) => {
      const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();
      const input = node as HTMLInputElement;
      const labelText = input.labels ? Array.from(input.labels).map(item => clean(item.textContent ?? '')).join(' ') : '';
      const context = clean(input.closest('label')?.textContent ?? input.parentElement?.textContent ?? '');
      const label = labelText || context || input.getAttribute('aria-label') || input.name || input.id || '';
      const files = Array.from(input.files ?? []);
      return { index, name: input.name || input.id || label, fileName: files[0]?.name ?? '', label, accept: input.accept, required: input.required, size: files.reduce((sum, file) => sum + file.size, 0), type: files.map(file => file.type).join(',') };
    }));
  }

  private async snapshot(page: Page): Promise<PortalSnapshot> {
    return { url: displayUrl(page.url()), fields: await this.formFields(page), files: await this.fileInputs(page) };
  }

  private async uploadArtifacts(page: Page, material: Material, bundle: DisclosureBundle): Promise<{ cv: FileDescription; cover?: FileDescription; coverTextFilled: boolean }> {
    const inputs = await this.fileInputs(page);
    if (!inputs.length) throw new Error('The application form has no visible CV/resume upload field; no application was prepared.');
    const resumeCandidates = inputs.filter(file => /resume|curriculum|cv|riwayat|daftar riwayat/i.test(file.label));
    const cvInput = resumeCandidates.length === 1 ? resumeCandidates[0] : resumeCandidates.length === 0 && inputs.length === 1 && !/cover|letter|surat lamaran/i.test(inputs[0]!.label) ? inputs[0] : undefined;
    if (!cvInput) throw new Error('The application form has ambiguous CV/resume upload fields. Select the correct file manually; no file was uploaded.');
    const cvLocator = page.locator('form input[type="file"]').nth(cvInput.index);
    await cvLocator.setInputFiles(this.ws.path(material.files.pdf));
    const afterCv = await this.fileInputs(page);
    const selectedCv = afterCv[cvInput.index];
    if (!selectedCv || selectedCv.fileName !== bundle.cvFileName || selectedCv.size !== this.ws.read(material.files.pdf).byteLength) throw new Error('The portal did not retain the exact approved CV file selection. Stop and review the visible form.');

    const coverCandidates = inputs.filter(file => file.index !== cvInput.index && /cover|letter|surat lamaran/i.test(file.label));
    let cover: FileDescription | undefined;
    let coverTextFilled = false;
    if (coverCandidates.length > 1) throw new Error('The application form has ambiguous cover-letter upload fields.');
    if (coverCandidates.length === 1) {
      const coverInput = coverCandidates[0]!;
      const coverLocator = page.locator('form input[type="file"]').nth(coverInput.index);
      await coverLocator.setInputFiles(this.ws.path(material.files.letter));
      cover = (await this.fileInputs(page))[coverInput.index];
      if (!cover || cover.fileName !== bundle.coverFileName || cover.size !== this.ws.read(material.files.letter).byteLength) throw new Error('The portal did not retain the exact approved cover-letter file selection.');
    } else {
      const textFields = page.locator('form textarea, form [contenteditable="true"]');
      const labels = await textFields.evaluateAll(nodes => nodes.map((node, index) => {
        const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();
        const element = node as HTMLElement;
        const associated = element instanceof HTMLTextAreaElement && element.labels ? Array.from(element.labels).map(label => clean(label.textContent ?? '')).join(' ') : '';
        return { index, label: associated || clean(element.getAttribute('aria-label') ?? element.getAttribute('name') ?? element.id ?? '') };
      }));
      const letterField = labels.find(field => /cover letter|covering letter|letter of application|surat lamaran/i.test(field.label));
      if (letterField) {
        const letterLocator = textFields.nth(letterField.index);
        await letterLocator.fill(bundle.coverText);
        const actual = await letterLocator.evaluate(element => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element.value : element.textContent ?? '');
        if (actual !== bundle.coverText) throw new Error('The portal did not retain the exact approved cover-letter text.');
        coverTextFilled = true;
      }
    }
    return { cv: selectedCv, ...(cover ? { cover } : {}), coverTextFilled };
  }

  private async hasBoostSelection(page: Page): Promise<boolean> {
    return page.locator('input:checked, [role="checkbox"][aria-checked="true"], [role="radio"][aria-checked="true"], button[aria-pressed="true"]').evaluateAll(nodes => nodes.some(node => {
      const element = node as HTMLElement;
      const labels = element instanceof HTMLInputElement && element.labels ? Array.from(element.labels).map(label => label.textContent ?? '').join(' ') : '';
      const context = [labels, element.getAttribute('aria-label'), element.getAttribute('data-testid'), element.closest('label')?.textContent, element.parentElement?.textContent, element.textContent].filter(Boolean).join(' ');
      return /boost|promot(?:e|ion)|bump|promosikan/i.test(context);
    }));
  }

  private async readFlow(materialId: string): Promise<{ attempt: Attempt; flow: FlowState }> {
    const material = verifyMaterial(this.ws, materialId);
    const attempt = this.ws.store.require<Attempt>('attempts', material.attemptId);
    const flow = stateOf(attempt);
    if (!flow || flow.materialId !== material.id || flow.attemptId !== attempt.id || flow.vacancyId !== material.vacancyId) throw new Error('No prepared Jobstreet application exists for this material revision. Run prepare first.');
    return { attempt, flow };
  }

  private saveFlow(attempt: Attempt, flow: FlowState, event: string): void {
    flow.updatedAt = now();
    attempt.jobstreet = flow;
    this.ws.store.tx(() => { this.ws.store.put('attempts', attempt); this.ws.store.event(event, attempt.id, { materialId: flow.materialId, vacancyId: flow.vacancyId, state: flow.state, targetUrl: flow.targetUrl, ...(flow.operationId ? { operationId: flow.operationId } : {}) }); });
  }

  private async openSavedApplication(page: Page, flow: FlowState): Promise<void> {
    if (displayUrl(page.url()) === flow.applyUrl) return;
    if (displayUrl(page.url()) !== flow.targetUrl) await this.go(page, flow.targetUrl);
    if (flow.applyUrl !== flow.targetUrl) { await this.go(page, flow.applyUrl); return; }
    const action = page.getByRole('link', { name: APPLY_COPY }).first();
    if (await action.isVisible().catch(() => false)) await action.click();
    else await page.getByRole('button', { name: APPLY_COPY }).first().click();
    await page.locator('form').waitFor({ state: 'visible', timeout: 10000 });
  }

  async prepare(materialId: string, answers: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const validAnswers = ANSWERS.safeParse(answers);
    if (!validAnswers.success) throw new Error('Screening answers must be a record of non-empty user-provided strings (maximum 2,000 characters each).');
    const material = verifyMaterial(this.ws, materialId);
    const attempt = this.ws.store.require<Attempt>('attempts', material.attemptId);
    const existingFlow = stateOf(attempt);
    if (['submitting', 'submission_uncertain', 'applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn', 'closed'].includes(attempt.status)) return { state: attempt.status === 'submitting' ? 'submission_uncertain' : attempt.status, targetUrl: existingFlow?.targetUrl ?? null, message: 'This attempt is already submitted or uncertain. No new Jobstreet application was opened.' };
    if (existingFlow && ['prepared', 'reviewed', 'submission_uncertain', 'portal_observed', 'submission_blocked', 'external_apply', 'unsafe_prefill'].includes(existingFlow.state)) return { state: existingFlow.state, materialId: material.id, targetUrl: existingFlow.targetUrl, message: 'The existing Jobstreet application state was retained. No new application or upload was started.' };
    if (existingFlow?.state === 'opening_application') return { state: 'application_flow_interrupted', targetUrl: existingFlow.targetUrl, message: 'A previous Jobstreet transition did not finish cleanly. Inspect the visible portal and do not restart automatically.' };
    const contentBinding = bindingFor(this.ws, 'content', materialId);
    authorize(this.ws, 'content', materialId, contentBinding, { materialId, title: material.title, manifestHash: material.manifestHash }, false, material.attemptId);
    const { page } = await this.browser();
    let flow: FlowState;
    let vacancy: Vacancy;

    if (existingFlow?.state === 'answers_required' || existingFlow?.state === 'boost_selected') {
      if (!this.isPortalUrl(page.url()) || !new URL(page.url()).pathname.includes('/apply') || !await page.locator('form').first().isVisible().catch(() => false)) return { state: 'application_flow_interrupted', targetUrl: existingFlow.targetUrl, message: 'The saved screening step is no longer open in this Jobstreet session. Do not restart automatically; inspect the visible portal.' };
      const changedAnswers = Object.entries(validAnswers.data).filter(([key, value]) => Object.hasOwn(existingFlow.answers, key) && existingFlow.answers[key] !== value).map(([key]) => key);
      if (changedAnswers.length) return { state: 'screening_answer_revision_blocked', targetUrl: existingFlow.targetUrl, changedAnswers, message: 'An earlier user-confirmed answer cannot be silently revised in the current portal step. Start a new application revision before changing it.' };
      flow = existingFlow;
      flow.answers = { ...existingFlow.answers, ...validAnswers.data };
      vacancy = this.ws.store.require<Vacancy>('vacancies', flow.vacancyId);
      const binding = hash(stable({ workspaceId: this.ws.settings().workspaceId, action: 'disclosure', materialId: material.id, attemptId: attempt.id, vacancyId: vacancy.id, targetUrl: flow.targetUrl, applyUrl: flow.applyUrl, manifestHash: material.manifestHash, answers: flow.answers }));
      flow.disclosureBinding = binding;
      authorize(this.ws, 'disclosure', material.id, binding, {
        portal: 'Jobstreet', target: { role: vacancy.role, company: vacancy.company, detailUrl: flow.targetUrl, applicationUrl: page.url() },
        artifacts: { cvFileName: flow.disclosureBundle.cvFileName, cvSha256: flow.disclosureBundle.cvHash, cvText: flow.disclosureBundle.cvText, coverFileName: flow.disclosureBundle.coverFileName, coverSha256: flow.disclosureBundle.coverHash, coverText: flow.disclosureBundle.coverText },
        userProvidedScreeningValues: flow.answers,
        disclosure: 'Jobstreet may receive the selected materials and any profile or screening data already present in this application. This approval does not authorize final submission.'
      }, false, attempt.id);
      flow.state = 'opening_application';
      this.saveFlow(attempt, flow, 'jobstreet_application_resumed');
    } else {
      vacancy = this.ws.store.require<Vacancy>('vacancies', material.vacancyId);
      if (!vacancy.url) throw new Error('This vacancy has no verified Jobstreet target URL. Scrape saved jobs again before preparing.');
      const targetUrl = displayUrl(new URL(vacancy.url, this.baseUrl).toString());
      if (!this.isPortalUrl(targetUrl)) throw new Error('The vacancy URL is outside the configured Jobstreet host; no portal action was taken.');
      const bundle = await this.disclosureBundle(material);
      const detailNavigation = await this.go(page, targetUrl);
      const gate = await this.gate(page, detailNavigation.status);
      if (gate) return { state: gate, url: page.url(), message: gate === 'blocked' ? 'Jobstreet blocked access or requires a CAPTCHA. Complete the challenge manually; no bypass was attempted.' : 'Sign in manually in the visible browser, then prepare again.' };
      const detail = await this.detail(page);
      if (!detail) return { state: 'incomplete_target', targetUrl, message: 'The live target did not expose a readable title, advertiser, and description; no application was opened.' };
      if (!sameText(detail.role, vacancy.role) || !sameText(detail.company, vacancy.company)) return { state: 'stale_target', targetUrl, expected: { role: vacancy.role, company: vacancy.company }, observed: { role: detail.role, company: detail.company }, message: 'The saved vacancy no longer matches the live listing. No application was opened and the existing vacancy was not overwritten.' };
      const action = await this.applyAction(page);
      if (action.externalUrl) return { state: 'external_apply', targetUrl, externalApplyUrl: action.externalUrl, message: 'This listing sends applications to an external employer site. Jose will not follow that link or transmit application data there.' };
      const applyUrl = displayUrl(action.applyUrl);
      if (!this.isPortalUrl(applyUrl)) return { state: 'external_apply', targetUrl, externalApplyUrl: applyUrl, message: 'The application destination is outside Jobstreet. No external transition or upload was made.' };
      const disclosureBinding = hash(stable({ workspaceId: this.ws.settings().workspaceId, action: 'disclosure', materialId: material.id, attemptId: attempt.id, vacancyId: vacancy.id, targetUrl, applyUrl, manifestHash: material.manifestHash, answers: validAnswers.data }));
      flow = { state: 'disclosure_pending', materialId: material.id, attemptId: attempt.id, vacancyId: vacancy.id, targetUrl, applyUrl, disclosureBinding, disclosureBundle: bundle, answers: validAnswers.data, questions: [], baselineProfile: [], updatedAt: now() };
      this.saveFlow(attempt, flow, 'jobstreet_disclosure_pending');
      authorize(this.ws, 'disclosure', material.id, disclosureBinding, {
        portal: 'Jobstreet', target: { role: detail.role, company: detail.company, detailUrl: targetUrl, applicationUrl: applyUrl },
        artifacts: { cvFileName: bundle.cvFileName, cvSha256: bundle.cvHash, cvText: bundle.cvText, coverFileName: bundle.coverFileName, coverSha256: bundle.coverHash, coverText: bundle.coverText },
        userProvidedScreeningValues: flow.answers,
        disclosure: 'After approval, Jobstreet may receive the selected CV and cover-letter text and may read profile data already present in the visible application form. This approval does not authorize the final submit button; a separate per-target submit approval is required.'
      }, false, attempt.id);
      flow.state = 'opening_application';
      this.saveFlow(attempt, flow, 'jobstreet_application_opening');
      if (applyUrl !== targetUrl) await this.go(page, applyUrl);
      else if (action.buttonName) await page.getByRole('button', { name: action.buttonName, exact: true }).click();
      else if (action.linkIndex !== undefined) await page.locator('a').nth(action.linkIndex).click();
      else {
        const button = page.getByRole('button', { name: APPLY_COPY }).first();
        if (!await button.isVisible().catch(() => false)) return { state: 'apply_action_missing', targetUrl, message: 'No safe Jobstreet quick-apply control was found. No application data was uploaded.' };
        await button.click();
      }
      if (this.blockedExternalUrl) {
        flow.state = 'external_apply';
        flow.blockedExternalUrl = this.blockedExternalUrl;
        this.saveFlow(attempt, flow, 'jobstreet_external_apply_blocked');
        return { state: 'external_apply', targetUrl, externalApplyUrl: this.blockedExternalUrl, message: 'Jobstreet attempted an external application transition; navigation was blocked.' };
      }
    }

    const afterGate = await this.gate(page);
    if (afterGate) return { state: afterGate, url: page.url(), message: 'The application page is blocked or requires manual sign-in/verification.' };
    if (!await page.locator('form').first().isVisible().catch(() => false)) await page.locator('form').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => undefined);
    if (!await page.locator('form').first().isVisible().catch(() => false)) return { state: 'application_form_missing', targetUrl: flow.targetUrl, applicationUrl: page.url(), message: 'The Jobstreet quick-apply form did not appear. No application was submitted.' };

    const rememberProfile = (fields: FormField[]): boolean => {
      for (const field of fields) {
        if (/cover letter|covering letter|letter of application|surat lamaran/i.test(`${field.key} ${field.label}`)) continue;
        const previous = flow.baselineProfile.find(item => item.key === field.key);
        if (previous && (previous.type !== field.type || previous.value !== field.value || previous.checked !== field.checked)) return false;
        if (!previous) flow.baselineProfile.push(field);
      }
      return true;
    };
    let coverTextFilled = false;
    let reachedReview = false;
    for (let step = 0; step < 10; step++) {
      const gate = await this.gate(page);
      if (gate) return { state: gate, url: page.url(), message: 'The application wizard is blocked or requires manual sign-in/verification.' };
      if (await this.hasBoostSelection(page)) {
        flow.state = 'boost_selected';
        this.saveFlow(attempt, flow, 'jobstreet_boost_selected');
        return { state: 'boost_selected', targetUrl: flow.targetUrl, applicationUrl: page.url(), message: 'A boost or promotion option is selected. Jose will not continue or submit this application while it is active.' };
      }
      const stepQuestions = await this.questions(page);
      const unsafePrefill = stepQuestions.filter(question => question.fields.some(hasNonEmptyValue) && !flow.questions.some(previous => previous.key === question.key && stable(previous.fields) === stable(question.fields)));
      if (unsafePrefill.length) {
        flow.state = 'unsafe_prefill';
        this.saveFlow(attempt, flow, 'jobstreet_unsafe_prefill');
        return { state: 'unsafe_prefill', targetUrl: flow.targetUrl, applicationUrl: page.url(), questions: unsafePrefill.map(({ key, prompt }) => ({ key, prompt })), message: 'The portal contains screening values that were not entered and recorded by this session. Jose stopped without overwriting them.' };
      }
      for (const question of stepQuestions) {
        const index = flow.questions.findIndex(previous => previous.key === question.key);
        if (index >= 0 && flow.questions[index]?.prompt !== question.prompt) return { state: 'question_identity_changed', targetUrl: flow.targetUrl, key: question.key, message: 'The portal reused a screening key for a different prompt. No answer was entered.' };
        if (index >= 0) flow.questions[index] = question;
        else flow.questions.push(question);
      }
      const missing = stepQuestions.filter(question => question.required && !flow.answers[question.key]);
      if (missing.length) {
        flow.state = 'answers_required';
        this.saveFlow(attempt, flow, 'jobstreet_screening_answers_required');
        return { state: 'answers_required', targetUrl: flow.targetUrl, applicationUrl: page.url(), questions: stepQuestions.map(({ key, prompt, required }) => ({ key, prompt, required })), missing: missing.map(({ key, prompt }) => ({ key, prompt })), message: 'Provide explicit user-confirmed values for each required screening question; the visible application step remains open.' };
      }
      const profileBefore = await this.formFields(page);
      if (!rememberProfile(profileBefore)) {
        flow.state = 'unsafe_prefill';
        this.saveFlow(attempt, flow, 'jobstreet_profile_changed');
        return { state: 'unsafe_prefill', targetUrl: flow.targetUrl, applicationUrl: page.url(), message: 'A profile, contact, primary-CV, or visibility field changed between application steps. Jose stopped.' };
      }
      for (const question of stepQuestions) {
        const answer = flow.answers[question.key];
        if (answer !== undefined) await this.answerQuestion(page, question, answer);
      }
      const currentQuestions = await this.questions(page);
      for (const question of currentQuestions) {
        const index = flow.questions.findIndex(previous => previous.key === question.key);
        if (index >= 0) flow.questions[index] = question;
        else flow.questions.push(question);
      }
      let upload: { cv: FileDescription; cover?: FileDescription; coverTextFilled: boolean } | undefined;
      if ((await this.fileInputs(page)).length) {
        upload = await this.uploadArtifacts(page, material, flow.disclosureBundle);
        flow.coverTextFilled ||= upload.coverTextFilled;
        flow.preparedSnapshot = await this.snapshot(page);
      }
      const profileAfter = await this.formFields(page);
      if (stable(profileBefore.filter(field => !/cover letter|covering letter|letter of application|surat lamaran/i.test(`${field.key} ${field.label}`))) !== stable(profileAfter.filter(field => !/cover letter|covering letter|letter of application|surat lamaran/i.test(`${field.key} ${field.label}`))) || !rememberProfile(profileAfter)) {
        flow.state = 'unsafe_prefill';
        this.saveFlow(attempt, flow, 'jobstreet_profile_changed');
        return { state: 'unsafe_prefill', targetUrl: flow.targetUrl, applicationUrl: page.url(), message: 'A profile/contact/primary-CV/visibility field changed while preparing. Jose stopped before final submission.' };
      }
      const currentPath = new URL(page.url()).pathname.toLocaleLowerCase();
      const finalButton = page.getByRole('button', { name: /^(submit(?: application)?|send application|kirim lamaran|kirim aplikasi)$/i }).first();
      const finalStep = currentPath.includes('/apply/review') || await finalButton.isVisible().catch(() => false);
      if (finalStep) { reachedReview = true; break; }
      const nextButtons = page.getByRole('button', { name: /^(lanjut(?:kan)?|next|continue|review(?: application)?|selanjutnya|tinjau(?: lamaran)?)$/i });
      const nextLinks = page.getByRole('link', { name: /^(lanjut(?:kan)?|next|continue|review(?: application)?|selanjutnya|tinjau(?: lamaran)?)$/i });
      const buttonCount = await nextButtons.count();
      const linkCount = await nextLinks.count();
      if (buttonCount + linkCount > 1) return { state: 'application_step_ambiguous', targetUrl: flow.targetUrl, applicationUrl: page.url(), message: 'More than one continuation control is visible. Jose stopped rather than choose a portal action.' };
      if (buttonCount + linkCount === 0) {
        if (flow.preparedSnapshot?.files.some(file => file.fileName === flow.disclosureBundle.cvFileName)) { reachedReview = true; break; }
        return { state: 'resume_upload_missing', targetUrl: flow.targetUrl, applicationUrl: page.url(), message: 'The application wizard has no unambiguous next step or selected CV. No submission was made.' };
      }
      const next = buttonCount ? nextButtons.first() : nextLinks.first();
      if (!buttonCount) {
        const href = await next.getAttribute('href');
        if (href && !this.isPortalUrl(new URL(href, page.url()).toString())) return { state: 'external_apply', targetUrl: flow.targetUrl, externalApplyUrl: href, message: 'The next application step is external. Jose did not follow it.' };
      }
      this.blockedExternalUrl = null;
      await next.click();
      await page.waitForTimeout(250);
      if (this.blockedExternalUrl) {
        flow.state = 'external_apply';
        flow.blockedExternalUrl = this.blockedExternalUrl;
        this.saveFlow(attempt, flow, 'jobstreet_external_apply_blocked');
        return { state: 'external_apply', targetUrl: flow.targetUrl, externalApplyUrl: this.blockedExternalUrl, message: 'The application wizard attempted an external transition; navigation was blocked.' };
      }
      if (SUCCESS_COPY.test(await this.bodyText(page)) || /\/apply\/success(?:\/|$)/i.test(new URL(page.url()).pathname)) {
        flow.state = 'submission_uncertain';
        attempt.status = 'submission_uncertain';
        this.saveFlow(attempt, flow, 'jobstreet_unapproved_success_transition');
        return { state: 'submission_uncertain', targetUrl: flow.targetUrl, message: 'The portal displayed a success state during a non-submit transition. Do not retry; confirm the outcome manually.' };
      }
    }
    const unknownAnswers = Object.keys(flow.answers).filter(key => !flow.questions.some(question => question.key === key));
    if (unknownAnswers.length) return { state: 'unknown_screening_answers', targetUrl: flow.targetUrl, unknownAnswers, questions: flow.questions.map(({ key, prompt, required }) => ({ key, prompt, required })), message: 'One or more supplied values did not map to a current portal question.' };
    if (!reachedReview) return { state: 'application_step_limit', targetUrl: flow.targetUrl, applicationUrl: page.url(), message: 'The application wizard exceeded the supported step limit; no final submit was attempted.' };
    const selectedCv = flow.preparedSnapshot?.files.find(file => file.fileName === flow.disclosureBundle.cvFileName);
    if (!selectedCv) return { state: 'resume_upload_missing', targetUrl: flow.targetUrl, applicationUrl: page.url(), message: 'No exact approved CV upload was selected in the Jobstreet application.' };
    const selectedCover = flow.preparedSnapshot?.files.find(file => file.fileName === flow.disclosureBundle.coverFileName);
    flow.coverTextFilled = coverTextFilled;
    flow.state = 'prepared';
    this.saveFlow(attempt, flow, 'jobstreet_prepared');
    return {
      state: 'prepared', materialId: material.id, attemptId: material.attemptId, vacancyId: vacancy.id,
      target: { role: vacancy.role, company: vacancy.company, url: flow.targetUrl }, applicationUrl: page.url(),
      artifacts: { cvFileName: selectedCv.fileName, cvBytes: selectedCv.size, cvSha256: flow.disclosureBundle.cvHash, coverFileName: selectedCover?.fileName ?? null, coverBytes: selectedCover?.size ?? null, coverTextFilled, coverSha256: selectedCover ? flow.disclosureBundle.coverHash : null },
      screening: flow.questions.map(question => ({ key: question.key, prompt: question.prompt, value: question.fields.map(field => field.checked ? field.label || field.value : '').filter(Boolean).join(', ') || question.fields.find(field => !['radio', 'checkbox'].includes(field.type))?.value || null })),
      profileAndVisibilityUnchanged: true, finalReviewReached: reachedReview
    };
  }

  private async currentSnapshot(flow: FlowState, material: Material, page: Page): Promise<{ snapshot: PortalSnapshot; vacancy: Vacancy; selectedFiles: FileDescription[] }> {
    if (!this.isPortalUrl(page.url())) throw new Error('The current portal page is outside Jobstreet; the application review is unsafe.');
    const vacancy = this.ws.store.require<Vacancy>('vacancies', flow.vacancyId);
    if (!vacancy.url || displayUrl(new URL(vacancy.url, this.baseUrl).toString()) !== flow.targetUrl) throw new Error('The stored vacancy target changed after preparation. Create a new review instead of submitting.');
    const pageText = await this.bodyText(page);
    const targetPath = new URL(flow.targetUrl).pathname.split('/').filter(Boolean).at(-1) ?? '';
    const targetInUrl = !!targetPath && new URL(page.url()).pathname.includes(targetPath);
    const targetInText = pageText.toLocaleLowerCase().includes(vacancy.role.toLocaleLowerCase()) || (vacancy.portalId ? pageText.includes(vacancy.portalId.replace(/^jobstreet:/, '')) : false);
    if (!targetInUrl && !targetInText) throw new Error('The application page no longer identifies the approved vacancy target.');
    const snapshot = await this.snapshot(page);
    const selectedFiles = snapshot.files.length ? snapshot.files : flow.preparedSnapshot?.files ?? [];
    const expectedCv = fileName(material.files.pdf);
    const selected = selectedFiles.find(file => file.fileName === expectedCv);
    if (!selected || selected.size !== this.ws.read(material.files.pdf).byteLength) throw new Error('The actual selected CV no longer matches the approved material. Run prepare again.');
    for (const baseline of flow.baselineProfile) {
      const current = snapshot.fields.find(field => field.key === baseline.key);
      if (current && (current.type !== baseline.type || current.value !== baseline.value || current.checked !== baseline.checked)) throw new Error('A primary CV, profile, contact, or visibility field changed after preparation. The final submit is blocked.');
    }
    return { snapshot, vacancy, selectedFiles };
  }

  private reviewBinding(material: Material, attemptId: string, vacancy: Vacancy, snapshot: PortalSnapshot, selectedFiles: FileDescription[], questions: Question[]): string {
    return hash(stable({ workspaceId: this.ws.settings().workspaceId, action: 'submit', materialId: material.id, attemptId, vacancyId: vacancy.id, targetUrl: vacancy.url, actualApplicationUrl: snapshot.url, manifestHash: material.manifestHash, actualFields: snapshot.fields, selectedFiles, screening: questions }));
  }

  async review(materialId: string): Promise<Record<string, unknown>> {
    const { attempt, flow } = await this.readFlow(materialId);
    if (flow.state === 'submitting' || flow.state === 'submission_uncertain' || flow.state === 'portal_observed') return { state: flow.state, targetUrl: flow.targetUrl, message: 'This application has already entered submission or observation; do not retry.' };
    if (!['prepared', 'reviewed'].includes(flow.state)) return { state: flow.state, targetUrl: flow.targetUrl, message: 'This Jobstreet application is not ready for review.' };
    const material = verifyMaterial(this.ws, materialId);
    const { page } = await this.browser();
    if (!this.isPortalUrl(page.url()) || !new URL(page.url()).pathname.includes('/apply')) {
      authorize(this.ws, 'disclosure', material.id, flow.disclosureBinding, { portal: 'Jobstreet', targetUrl: flow.targetUrl, applicationUrl: flow.applyUrl, artifacts: { cvFileName: flow.disclosureBundle.cvFileName, coverFileName: flow.disclosureBundle.coverFileName }, disclosure: 'Reopen the previously approved Jobstreet application form.' }, false, attempt.id);
      await this.openSavedApplication(page, flow);
    }
    const gate = await this.gate(page);
    if (gate) return { state: gate, url: page.url(), message: 'The portal session is blocked or expired. Resolve it manually before review.' };
    const currentQuestions = await this.questions(page);
    for (const question of currentQuestions) {
      const index = flow.questions.findIndex(previous => previous.key === question.key);
      const previous = flow.questions[index];
      if (!previous || previous.prompt !== question.prompt || stable(previous.fields) !== stable(question.fields)) {
        flow.state = 'unsafe_prefill';
        this.saveFlow(attempt, flow, 'jobstreet_screening_changed');
        return { state: 'unsafe_prefill', targetUrl: flow.targetUrl, key: question.key, message: 'The portal screening values changed after preparation. Jose stopped rather than accept an unconfirmed prefill.' };
      }
      flow.questions[index] = question;
    }
    if (await this.hasBoostSelection(page)) return { state: 'boost_selected', targetUrl: flow.targetUrl, message: 'A boost or promotion option is selected. Jose will not submit an application that may spend or activate it.' };
    const { snapshot, vacancy, selectedFiles } = await this.currentSnapshot(flow, material, page);
    const binding = this.reviewBinding(material, attempt.id, vacancy, snapshot, selectedFiles, flow.questions);
    const summary = {
      target: { role: vacancy.role, company: vacancy.company, url: flow.targetUrl, applicationUrl: snapshot.url, portalId: vacancy.portalId ?? null },
      material: { materialId: material.id, attemptId: attempt.id, title: material.title, cvFileName: flow.disclosureBundle.cvFileName, cvSha256: flow.disclosureBundle.cvHash, cvText: flow.disclosureBundle.cvText, coverFile: selectedFiles.find(file => file.fileName === flow.disclosureBundle.coverFileName) ? { fileName: flow.disclosureBundle.coverFileName, sha256: flow.disclosureBundle.coverHash, text: flow.disclosureBundle.coverText } : null, coverText: flow.coverTextFilled ? flow.disclosureBundle.coverText : null },
      actualFields: snapshot.fields.map(({ key, type, value, checked, label }) => ({ key, type, value, checked, label })),
      screening: flow.questions.map(question => ({ key: question.key, prompt: question.prompt, required: question.required, values: question.fields.map(field => ({ type: field.type, label: field.label, value: field.value, checked: field.checked })) })),
      selectedFiles: selectedFiles.map(({ fileName, label, size, type }) => ({ name: fileName, label, size, type })),
      noBoosts: true
    };
    flow.state = 'reviewed';
    flow.reviewedSnapshot = snapshot;
    flow.reviewBinding = binding;
    this.saveFlow(attempt, flow, 'jobstreet_reviewed');
    const approval = authorize(this.ws, 'submit', material.id, binding, summary, false, attempt.id);
    return { state: 'submit_approved', target: summary.target, artifacts: summary.material, actualFields: summary.actualFields, screening: summary.screening, selectedFiles: summary.selectedFiles, reviewBinding: binding, approvalId: approval.id, noBoosts: true };
  }

  async submit(materialId: string): Promise<Record<string, unknown>> {
    const { attempt, flow } = await this.readFlow(materialId);
    if (flow.state === 'submission_uncertain' || flow.state === 'submitting' || attempt.status === 'submitting') {
      flow.state = 'submission_uncertain';
      attempt.status = 'submission_uncertain';
      this.saveFlow(attempt, flow, 'jobstreet_submission_uncertain');
      return { state: 'submission_uncertain', targetUrl: flow.targetUrl, operationId: flow.operationId ?? null, message: 'Submission may already have reached Jobstreet. No retry was made; check the portal manually.' };
    }
    if (flow.state === 'portal_observed') return { state: 'portal_observed', targetUrl: flow.targetUrl, operationId: flow.operationId ?? null, message: 'Jobstreet success was already observed for this application.' };
    if (flow.state !== 'reviewed' || !flow.reviewBinding || !flow.reviewedSnapshot) throw new Error('A fresh Jobstreet review and per-target submit approval are required before submitting.');
    const material = verifyMaterial(this.ws, materialId);
    const { page } = await this.browser();
    const gate = await this.gate(page);
    if (gate) return { state: gate, url: page.url(), message: 'The portal session is blocked or expired; submit approval was not consumed.' };
    const currentQuestions = await this.questions(page);
    for (const question of currentQuestions) {
      const previous = flow.questions.find(item => item.key === question.key);
      if (!previous || stable(previous.fields) !== stable(question.fields)) throw new Error('A screening answer changed after final review. Review the current portal values again before submission.');
    }
    if (await this.hasBoostSelection(page)) return { state: 'boost_selected', targetUrl: flow.targetUrl, message: 'A boost or promotion option is selected. Jose will not submit an application that may spend or activate it.' };
    const { snapshot, vacancy, selectedFiles } = await this.currentSnapshot(flow, material, page);
    const binding = this.reviewBinding(material, attempt.id, vacancy, snapshot, selectedFiles, flow.questions);
    if (binding !== flow.reviewBinding || stable(snapshot) !== stable(flow.reviewedSnapshot)) throw new Error('The application form changed after review. No submission occurred; review the current fields again.');
    const summary = { targetUrl: flow.targetUrl, materialId: material.id, attemptId: attempt.id, reviewBinding: binding, selectedFiles: selectedFiles.map(({ fileName, size }) => ({ fileName, size })) };
    consumeSubmission(this.ws, material.id, binding, summary, attempt.id);
    flow.state = 'submitting';
    flow.operationId = id();
    attempt.status = 'submitting';
    attempt.submissionBinding = binding;
    this.saveFlow(attempt, flow, 'jobstreet_submitting');

    let clickStarted = false;
    try {
      const buttons = page.getByRole('button', { name: /^(submit(?: application)?|send application|kirim lamaran|kirim aplikasi|kirim)$/i });
      let button: Locator | null = await buttons.first().isVisible().catch(() => false) ? buttons.first() : null;
      if (!button) {
        const submitInputs = page.locator('form button[type="submit"], form input[type="submit"]');
        if (await submitInputs.count() === 1) {
          const candidate = submitInputs.first();
          const label = normalizeText(await candidate.innerText().catch(() => '') || await candidate.getAttribute('value') || await candidate.getAttribute('aria-label') || '');
          if (!/boost|promot(?:e|ion)|bump|promosikan/i.test(label)) button = candidate;
        }
      }
      if (!button) {
        flow.state = 'submission_blocked';
        attempt.status = 'submission_blocked';
        this.saveFlow(attempt, flow, 'jobstreet_submit_control_missing');
        return { state: 'submission_blocked', targetUrl: flow.targetUrl, message: 'The reviewed form has no unambiguous final submit control. The one-use approval was consumed; no click was attempted.' };
      }
      clickStarted = true;
      await button.click({ timeout: 10000 });
      await Promise.race([
        page.getByText(SUCCESS_COPY).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined),
        page.locator('[data-application-success="true"], [data-testid*="application-success" i]').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined),
      ]);
      const postClickGate = await this.gate(page);
      const pageText = await this.bodyText(page);
      const success = SUCCESS_COPY.test(pageText) || await page.locator('[data-application-success=\"true\"], [data-testid*=\"application-success\" i]').count() > 0;
      const targetMatch = (vacancy.portalId ? pageText.includes(vacancy.portalId.replace(/^jobstreet:/, '')) : false) || pageText.toLocaleLowerCase().includes(vacancy.role.toLocaleLowerCase());
      const observedUrl = page.url();
      if (postClickGate === 'blocked') throw new Error('Jobstreet displayed a verification challenge after submit.');
      if (this.blockedExternalUrl) {
        flow.state = 'submission_blocked';
        attempt.status = 'submission_blocked';
        flow.blockedExternalUrl = this.blockedExternalUrl;
        this.saveFlow(attempt, flow, 'jobstreet_external_submit_blocked');
        return { state: 'external_apply', externalApplyUrl: this.blockedExternalUrl, targetUrl: flow.targetUrl, message: 'The portal attempted an external transition. The external navigation/request was blocked; submission was not reported.' };
      }
      if (!this.isPortalUrl(observedUrl)) throw new Error('The resulting URL is outside the configured Jobstreet host.');
      if (success && targetMatch) {
        const observedAt = now();
        flow.state = 'portal_observed';
        attempt.status = 'applied';
        attempt.jobstreet = flow;
        const recorded = reportApplication(this.ws, { attemptId: attempt.id, vacancyId: vacancy.id, materialId: material.id, status: 'applied', provenance: 'portal_observed', operationId: flow.operationId, evidence: { targetUrl: observedUrl, status: 'applied', observedAt, operationId: flow.operationId, portal: 'jobstreet', ...(vacancy.portalId ? { portalId: vacancy.portalId } : {}), materialId: material.id, attemptId: attempt.id } });
        recorded.status = 'applied';
        recorded.jobstreet = flow;
        recorded.submissionBinding = binding;
        this.ws.store.tx(() => { this.ws.store.put('attempts', recorded); this.ws.store.event('jobstreet_portal_observed', attempt.id, { materialId: material.id, vacancyId: vacancy.id, targetUrl: observedUrl, status: 'applied', observedAt, operationId: flow.operationId }); });
        return { state: 'portal_observed', targetUrl: observedUrl, materialId: material.id, attemptId: attempt.id, operationId: flow.operationId, status: recorded.status, message: 'A Jobstreet success signal matching the approved listing was observed and recorded.' };
      }
      flow.state = 'submission_uncertain';
      attempt.status = 'submission_uncertain';
      this.saveFlow(attempt, flow, 'jobstreet_submission_uncertain');
      return { state: 'submission_uncertain', targetUrl: observedUrl, operationId: flow.operationId, message: 'No matching Jobstreet success signal was observed after the submit action. The application may have reached the portal; do not retry automatically.' };
    } catch (error) {
      if (!clickStarted) throw error;
      const latest = this.ws.store.require<Attempt>('attempts', attempt.id);
      flow.state = 'submission_uncertain';
      latest.status = 'submission_uncertain';
      this.saveFlow(latest, flow, 'jobstreet_submission_uncertain');
      return { state: 'submission_uncertain', targetUrl: flow.targetUrl, operationId: flow.operationId, message: `The submit action may have reached Jobstreet, but its result was not verified (${error instanceof Error ? error.message : 'unknown browser error'}). Do not retry automatically.` };
    }
  }


  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.closed = true;
    if (context) await context.close().catch(() => undefined);
  }
}
