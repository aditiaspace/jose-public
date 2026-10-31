export type Language = 'en' | 'id';
export type Kind = 'settings' | 'sources' | 'profiles' | 'vacancies' | 'materials' | 'approvals' | 'attempts';
export interface Entity { id: string; }
export interface Settings extends Entity {
  id: 'settings'; workspaceId: string; language: Language; timezone: string; createdAt: string;
  profileId?: string; onboarding: 'not_started' | 'collecting' | 'awaiting_confirmation' | 'ready';
  editingMode?: 'self_edit' | 'chat'; resumeFormat?: 'bullet' | 'paragraph';
}
export interface Source extends Entity { name: string; path: string; hash: string; text: string; warnings: string[]; createdAt: string; }
export interface Fact { id: string; category: string; statement: string; sourceId: string; excerpt: string; confirmed: boolean; }
export interface Profile extends Entity { name: string; facts: Fact[]; preferences: Record<string, string>; openQuestions: string[]; createdAt: string; confirmedAt?: string; }
export interface Vacancy extends Entity { company: string; role: string; text: string; url?: string; portalId?: string; capturedAt: string; lastCheckedAt?: string; lifecycle?: 'live' | 'expired' | 'unknown'; notes: string; possibleDuplicates: string[]; }
export interface Material extends Entity {
  attemptId: string; vacancyId: string; profileId: string; language: 'en'; letterLanguage?: 'en' | 'id'; createdAt: string;
  editingMode?: 'self_edit' | 'chat'; resumeFormat?: 'bullet' | 'paragraph';
  files: { html: string; pdf: string; letter: string; evidence: string; docx?: string };
  fileHashes: Record<string,string>; manifestHash: string; title: string; approvedAt?: string;
  [key: string]: unknown;
}
export type ApprovalAction = 'profile' | 'content' | 'disclosure' | 'submit';
export interface Approval extends Entity {
  action: ApprovalAction; entityId: string; attemptId?: string; binding: string; summary: unknown;
  state: 'pending' | 'approved' | 'rejected' | 'consumed'; createdAt: string; expiresAt: string; decidedAt?: string;
}
export interface Attempt extends Entity {
  vacancyId: string; materialId?: string; createdAt: string; status: string; dateApplied?: string | null;
  provenance?: 'user_reported' | 'portal_observed'; evidence?: unknown; submissionBinding?: string;
  [key: string]: unknown;
}
export interface Result { [key: string]: unknown; }
