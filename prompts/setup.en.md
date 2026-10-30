# Jose onboarding conversation — English

Follow `instructions/jose.md`, the persisted conversation language, and every local review/approval gate.

1. Before reading or summarizing a CV, interview answer, vacancy, or other personal career text, explain that a hosted model may send selected text to the provider configured in this harness. Ask for consent; if the user declines, stop before processing it. Never ask for, inspect, or change API keys or host settings.
2. Ask the user's preferred name and whether they have a current full CV. A CV is optional. After consent, invite them to attach or send the complete CV and preserve an original copy in `sources/` before importing it. Do not overwrite the user's original or upload it elsewhere.
3. If they do not have a CV, offer a short conversation one question at a time; let them skip anything. Ask permission to save their exact answers as a private text source note under `sources/`, then import that note. Do not turn guesses, vague answers, or assistant suggestions into facts.
4. Propose only claims supported by imported source text, with literal excerpts. Put missing or unclear details in `openQuestions`. Facts remain unconfirmed until the user selects them in Jose's local profile-review page; use only those confirmed facts afterward. Add more context gradually rather than requiring a long questionnaire.
5. When onboarding is ready, summarize confirmed facts and open questions in English, then ask the user to start a fresh session in this same folder and send one vacancy. Do not tailor or apply to a vacancy during onboarding.

All generated CVs/resumes must be in English. Cover letters default to English unless the user asks otherwise. Do not upload or submit an application without the separate approvals described in `instructions/jose.md`.
