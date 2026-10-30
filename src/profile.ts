import { z } from 'zod';
import type { Fact, Profile, Settings, Source } from './contracts.js';
import { bindingFor, requestApproval } from './approval.js';
import type { Workspace } from './workspace.js';
import { hash, id, now } from './util.js';

const FACT_INPUT = z.object({
  category: z.string().trim().min(1).max(80),
  statement: z.string().trim().min(1).max(2000),
  sourceId: z.string().trim().min(1).max(100),
  excerpt: z.string().trim().min(1).max(4000),
}).strict();

const PROFILE_INPUT = z.object({
  name: z.string().trim().min(1).max(200),
  facts: z.array(FACT_INPUT).min(1).max(500),
  preferences: z.record(z.string(), z.string().trim().min(1).max(500)).optional(),
  openQuestions: z.array(z.string().trim().min(1).max(1000)).max(200).optional(),
}).strict();

function checkedSource(ws: Workspace, sourceId: string): Source {
  const source = ws.store.require<Source>('sources', sourceId);
  if (hash(ws.read(source.path)) !== source.hash) throw new Error(`Imported source changed after capture: ${source.name}.`);
  return source;
}

export function proposeProfile(ws: Workspace, input: unknown): Profile {
  const parsed = PROFILE_INPUT.parse(input);
  const facts: Fact[] = parsed.facts.map(proposed => {
    const source = checkedSource(ws, proposed.sourceId);
    if (!source.text.includes(proposed.excerpt)) {
      throw new Error(`Evidence quote for “${proposed.statement}” is not an exact excerpt from ${source.name}.`);
    }
    return {
      id: id(),
      category: proposed.category,
      statement: proposed.statement,
      sourceId: source.id,
      excerpt: proposed.excerpt,
      confirmed: false,
    };
  });
  const profile: Profile = {
    id: id(),
    name: parsed.name,
    facts,
    preferences: parsed.preferences ?? {},
    openQuestions: parsed.openQuestions ?? [],
    createdAt: now(),
  };

  ws.store.tx(() => {
    ws.store.create<Profile>('profiles', profile);
    const settings = ws.settings();
    if (!settings.profileId) {
      settings.onboarding = 'awaiting_confirmation';
      ws.store.put<Settings>('settings', settings);
    }
    ws.store.event('profile_proposed', profile.id, {
      factCount: facts.length,
      sourceIds: [...new Set(facts.map(fact => fact.sourceId))],
      openQuestionCount: profile.openQuestions.length,
    });
    requestApproval(ws, 'profile', profile.id, bindingFor(ws, 'profile', profile.id), {
      name: profile.name,
      facts: profile.facts.map(({ id: factId, category, statement, sourceId, excerpt }) => ({ factId, category, statement, sourceId, quote: excerpt })),
      openQuestions: profile.openQuestions,
      note: 'These are unconfirmed proposals. A human must verify each statement and source quote before the profile can be used.',
    });
  });
  return profile;
}

export function getContext(ws: Workspace): Record<string, unknown> {
  const settings = ws.settings();
  const current = settings.profileId ? ws.store.get<Profile>('profiles', settings.profileId) : null;
  const gaps: string[] = [];
  const facts: Array<Record<string, unknown>> = [];

  if (!current || !current.confirmedAt) {
    gaps.push('No confirmed career profile is available. Import the existing CV, propose evidence-backed facts, and complete human confirmation first.');
  } else {
    for (const fact of current.facts) {
      if (!fact.confirmed) {
        gaps.push(`Unconfirmed profile fact proposal needs clarification: ${fact.statement}`);
        continue;
      }
      try {
        const source = checkedSource(ws, fact.sourceId);
        if (!source.text.includes(fact.excerpt)) {
          gaps.push(`Source quote no longer matches imported text for fact ${fact.id}.`);
          continue;
        }
        facts.push({
          id: fact.id,
          category: fact.category,
          statement: fact.statement,
          sourceId: source.id,
          sourceName: source.name,
          quote: fact.excerpt,
        });
      } catch {
        gaps.push(`Source is unavailable or changed for fact ${fact.id}.`);
      }
    }
    gaps.push(...current.openQuestions);
  }

  return {
    schemaVersion: 1,
    workspace: { language: settings.language, onboarding: settings.onboarding },
    profileId: current?.confirmedAt ? current.id : null,
    identity: current?.confirmedAt ? { name: current.name } : null,
    facts,
    preferences: current?.confirmedAt ? current.preferences : {},
    openQuestions: current?.confirmedAt ? current.openQuestions : [],
    gaps,
    rules: [
      'Use only facts listed in this confirmed context; cite each candidate-specific claim by fact ID and a verbatim source quote.',
      'Fact references and quotes provide traceability, not proof that a claim is semantically true; the user must review every claim.',
      'Do not invent dates, metrics, employers, degrees, skills, salary, or declarations. Keep missing details in open questions.',
      'CVs and resumes must always be in English. Cover letters default to English unless the user asks for another language. The local CV language screen is only a limited check, not natural-language detection.',
      'Never mark profile or content approved. Human review happens in Jose local review.',
    ],
  };
}

export function refreshContext(ws: Workspace): void {
  ws.write('context/current.json', JSON.stringify(getContext(ws), null, 2) + '\n');
}
