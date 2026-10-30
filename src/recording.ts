import { z } from 'zod';
import type { Attempt, Material, Vacancy } from './contracts.js';
import type { Workspace } from './workspace.js';
import { hash, id, now, stable } from './util.js';

const StatusSchema = z.enum([
  'applied', 'screening', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'not_selected', 'closed',
]);
const IdentifierSchema = z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const DateAppliedSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
});
const JsonEvidenceSchema = z.unknown().superRefine((value, context) => {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded) > 16 * 1024) {
      context.addIssue({ code: 'custom', message: 'Evidence must be JSON data no larger than 16 KB.' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Evidence must be bounded JSON data.' });
  }
});
const PortalEvidenceSchema = z.object({
  targetUrl: z.url().max(2048),
  status: StatusSchema,
  observedAt: z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)) && /T/.test(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)),
  portal: z.literal('jobstreet'),
  portalId: IdentifierSchema.nullable().optional(),
  materialId: IdentifierSchema,
  attemptId: IdentifierSchema,
  operationId: IdentifierSchema,
}).strict();
const ReportInputSchema = z.object({
  attemptId: IdentifierSchema.optional(),
  vacancyId: IdentifierSchema.optional(),
  materialId: IdentifierSchema.optional(),
  dateApplied: DateAppliedSchema.nullable().optional(),
  status: StatusSchema.optional(),
  provenance: z.enum(['user_reported', 'portal_observed']).default('user_reported'),
  evidence: JsonEvidenceSchema.optional(),
  operationId: IdentifierSchema.optional(),
  reapply: z.boolean().default(false),
}).strict();

type ReportInput = z.infer<typeof ReportInputSchema>;
type PortalEvidence = z.infer<typeof PortalEvidenceSchema>;
type ApplicationEvent = {
  kind: string;
  entity_id: string;
  payload: unknown;
};

function isApplicationEvent(value: unknown): value is ApplicationEvent {
  return !!value && typeof value === 'object' &&
    typeof (value as ApplicationEvent).kind === 'string' &&
    (value as ApplicationEvent).kind.startsWith('application_') &&
    typeof (value as ApplicationEvent).entity_id === 'string' &&
    !!(value as ApplicationEvent).payload && typeof (value as ApplicationEvent).payload === 'object';
}

function resolveMaterial(ws: Workspace, input: ReportInput): { material: Material; vacancy: Vacancy } {
  const materials = ws.store.list<Material>('materials');
  let matches: Material[];
  if (input.materialId) matches = materials.filter((material) => material.id === input.materialId);
  else if (input.attemptId) {
    const attempt = ws.store.get<Attempt>('attempts', input.attemptId);
    matches = attempt?.materialId
      ? materials.filter((material) => material.id === attempt.materialId && material.attemptId === input.attemptId)
      : materials.filter((material) => material.attemptId === input.attemptId);
  }
  else if (input.vacancyId) {
    const matching = materials.filter((material) => material.vacancyId === input.vacancyId);
    const current = matching.filter((material) =>
      ws.store.get<Attempt>('attempts', material.attemptId)?.materialId === material.id);
    matches = current.length ? current : matching;
  }
  else throw new Error('A material, attempt, or vacancy identifier is required.');

  if (matches.length !== 1) {
    if (matches.length === 0) throw new Error('No unique application material matches the supplied identifiers.');
    if (input.attemptId) throw new Error('The attempt has multiple material revisions but no recorded current material.');
    throw new Error('The vacancy has multiple materials; specify materialId or attemptId.');
  }
  const material = matches[0]!;
  if (IdentifierSchema.parse(material.id) !== material.id || IdentifierSchema.parse(material.attemptId) !== material.attemptId ||
      IdentifierSchema.parse(material.vacancyId) !== material.vacancyId) throw new Error('The application material has an invalid identity.');
  if (input.attemptId && input.attemptId !== material.attemptId) throw new Error('attemptId does not match the selected material.');
  if (input.vacancyId && input.vacancyId !== material.vacancyId) throw new Error('vacancyId does not match the selected material.');
  const vacancy = ws.store.require<Vacancy>('vacancies', material.vacancyId);
  if (vacancy.id !== material.vacancyId) throw new Error('The selected material has an invalid vacancy reference.');
  return { material, vacancy };
}

function portalEvidence(input: ReportInput, material: Material, vacancy: Vacancy, status: z.infer<typeof StatusSchema>): PortalEvidence | undefined {
  if (input.provenance !== 'portal_observed') return undefined;
  if (!input.operationId) throw new Error('Portal-observed reports require operationId and matching observed evidence.');
  let evidence: PortalEvidence;
  try {
    evidence = PortalEvidenceSchema.parse(input.evidence);
  } catch (error) {
    throw new Error('Portal evidence is required and must include the observed success target, status, timestamp, material, attempt, and operation ID.', { cause: error });
  }
  if (evidence.operationId !== input.operationId || evidence.status !== status ||
      evidence.materialId !== material.id || evidence.attemptId !== material.attemptId) {
    throw new Error('Portal evidence must match the reported status, operation, material, and attempt.');
  }
  if (!vacancy.url) throw new Error('Portal evidence cannot be tied to a vacancy without its saved URL.');
  let observed: URL;
  let saved: URL;
  try {
    observed = new URL(evidence.targetUrl);
    saved = new URL(vacancy.url);
  } catch {
    throw new Error('Portal evidence must refer to a valid saved vacancy URL.');
  }
  if ((observed.protocol !== 'http:' && observed.protocol !== 'https:') ||
      (saved.protocol !== 'http:' && saved.protocol !== 'https:')) throw new Error('Portal evidence must use HTTP or HTTPS.');
  const sensitiveParameter = /^(?:access[_-]?token|refresh[_-]?token|token|auth(?:orization)?|session(?:id)?|sid|cookie|password|secret|credential|api[_-]?key|jwt)$/i;
  for (const url of [observed, saved]) {
    if (url.username || url.password || url.hash ||
        [...url.searchParams.keys()].some((name) => sensitiveParameter.test(name))) {
      throw new Error('Portal evidence URLs must not contain credentials or runtime tokens.');
    }
  }
  if (observed.origin !== saved.origin) throw new Error('Portal evidence target must share the saved vacancy origin.');
  if (vacancy.portalId && evidence.portalId !== vacancy.portalId) throw new Error('Portal evidence does not match the saved portal vacancy ID.');
  return evidence;
}

export function reportApplication(ws: Workspace, rawInput: unknown): Attempt {
  const input = ReportInputSchema.parse(rawInput);
  if (!input.materialId && !input.attemptId && !input.vacancyId) throw new Error('A material, attempt, or vacancy identifier is required.');
  if (input.reapply && input.status !== undefined && input.status !== 'applied') throw new Error('A reapplication must first be reported with status applied.');
  const operationId = input.operationId ?? id();

  return ws.store.tx(() => {
    const { material, vacancy } = resolveMaterial(ws, input);
    
    const normalizedEvidence = input.evidence === undefined ? undefined : JSON.parse(JSON.stringify(input.evidence)) as unknown;
    const intent = {
      attemptId: material.attemptId,
      vacancyId: vacancy.id,
      materialId: material.id,
      dateApplied: input.dateApplied ?? null,
      status: input.status ?? null,
      provenance: input.provenance,
      evidence: normalizedEvidence ?? null,
      reapply: input.reapply,
    };
    const fingerprint = hash(stable(intent));
    const events = ws.store.events();
    // ponytail: operation lookup scans history; index operation IDs in Store if event volume grows.

    for (const item of events) {
      if (!isApplicationEvent(item) || item.kind !== 'application_reported') continue;
      const payload = item.payload as Record<string, unknown>;
      if (payload.operationId !== operationId) continue;
      if (payload.attemptId !== material.attemptId || item.entity_id !== material.attemptId) {
        throw new Error('operationId has already been used for a different attempt.');
      }
      if (payload.requestHash !== fingerprint) throw new Error('operationId has already been used for a different report.');
      const previous = ws.store.get<Attempt>('attempts', item.entity_id);
      if (!previous) throw new Error('The prior application operation has no attempt record.');
      return previous;
    }

    const attempts = ws.store.list<Attempt>('attempts');
    if (attempts.some((attempt) => attempt.materialId === material.id && attempt.id !== material.attemptId)) {
      throw new Error('This material is already associated with a different attempt.');
    }

    const existing = ws.store.get<Attempt>('attempts', material.attemptId);
    const previousStatus = existing ? StatusSchema.safeParse(existing.status) : undefined;
    const status = input.status ?? (previousStatus?.success ? previousStatus.data : 'applied');
    if (input.reapply && status !== 'applied') throw new Error('A reapplication must first be reported with status applied.');
    portalEvidence(input, material, vacancy, status);
    if (existing && (existing.id !== material.attemptId || existing.vacancyId !== vacancy.id ||
        (existing.materialId && existing.materialId !== material.id))) {
      throw new Error('The existing attempt does not belong to this material and vacancy.');
    }
    const attemptMaterials = ws.store.list<Material>('materials').filter((other) => other.attemptId === material.attemptId);
    if (attemptMaterials.length > 1 && !existing?.materialId) {
      throw new Error('This attempt has multiple material revisions but no recorded current material.');
    }
    const priorReport = events.some((item) => {
      if (!isApplicationEvent(item) || item.kind !== 'application_reported') return false;
      const payload = item.payload as Record<string, unknown>;
      return payload.vacancyId === vacancy.id && payload.attemptId !== material.attemptId;
    });
    const priorAttempt = attempts.some((attempt) => attempt.vacancyId === vacancy.id && attempt.id !== material.attemptId &&
      (StatusSchema.safeParse(attempt.status).success || attempt.status === 'submitting' || attempt.status === 'submission_uncertain'));
    if ((priorReport || priorAttempt) !== input.reapply) {
      throw new Error(priorReport || priorAttempt
        ? 'A later application to this vacancy requires explicit reapply: true and a new material.'
        : 'reapply: true requires an earlier reported application to the same vacancy.');
    }

    const oldDate = existing?.dateApplied === undefined ? null : DateAppliedSchema.nullable().parse(existing.dateApplied);
    if (oldDate !== null && input.dateApplied !== undefined && input.dateApplied !== oldDate) {
      throw new Error('A recorded application date cannot be cleared or replaced.');
    }
    const dateApplied = oldDate ?? input.dateApplied ?? null;
    const attempt: Attempt = existing ?? {
      id: material.attemptId,
      vacancyId: vacancy.id,
      materialId: material.id,
      createdAt: now(),
      status,
      dateApplied: null,
    };
    attempt.vacancyId = vacancy.id;
    attempt.materialId = material.id;
    attempt.status = status;
    attempt.dateApplied = dateApplied;
    attempt.provenance = input.provenance;
    if (normalizedEvidence === undefined) delete attempt.evidence;
    else attempt.evidence = normalizedEvidence;
    attempt.operationId = operationId;

    if (existing) ws.store.put('attempts', attempt);
    else ws.store.create('attempts', attempt);
    ws.store.event('application_reported', attempt.id, {
      operationId,
      requestHash: fingerprint,
      attemptId: attempt.id,
      vacancyId: vacancy.id,
      materialId: material.id,
      dateApplied,
      status,
      provenance: input.provenance,
      ...(normalizedEvidence === undefined ? {} : { evidence: normalizedEvidence }),
      reapply: input.reapply,
    });
    return attempt;
  });
}

export function listApplications(ws: Workspace): Attempt[] {
  return ws.store.list<Attempt>('attempts').sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

export function applicationHistory(ws: Workspace, id?: string): unknown[] {
  if (id !== undefined) {
    IdentifierSchema.parse(id);
    return ws.store.events(id);
  }
  const attemptIds = new Set(ws.store.list<Attempt>('attempts').map((attempt) => attempt.id));
  return ws.store.events().filter((event) => {
    if (!event || typeof event !== 'object' || !('entity_id' in event)) return false;
    return typeof event.entity_id === 'string' && attemptIds.has(event.entity_id);
  });
}
