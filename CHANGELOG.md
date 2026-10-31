# Changelog

## Unreleased

## 0.3.0 — 2026-10-31

- Replace the localhost approval page with explicit chat decisions persisted by Jose's revision-bound approval CLI; only individually selected facts are confirmed.
- Add saved editing-mode and resume-format preferences, first-use Harvard FAS-inspired bullet/paragraph previews, self-edit DOCX output, edited-DOCX claim checks, and fresh approvals for revised material.
- Help users resolve missing Node.js/npm or Chromium during installation, verify doctor/context readiness, and offer Playwright Chromium only with explicit permission.
- Preserve self-edited DOCX files and saved workflow preferences through backup/restore; export relative material paths inside the active private workspace and omit the internal HTML draft from self-edit exports.

## 0.2.0 — 2026-10-30

- Replace the OpenCode/DeepSeek-Harness-specific launcher with a local, harness-agnostic Jose skill and CLI install in the user's current private folder; reuse the active harness's LLM and credentials without reading or changing them.
- Add project-level skill/instruction entrypoints for Claude Code, Codex, OpenCode, and DeepSeek Harness, with English and Bahasa Indonesia onboarding and English CV/resume artifacts.
- Make CV optional and support gradual conversational intake saved as user-approved, source-backed private notes; keep every proposed fact unconfirmed until local review.
- Keep local application recording, Jobstreet saved-job scraping, visible Playwright assisted apply, and separate disclosure/final-submit approvals.
- Add a bilingual static getting-started page with optional OpenCode and DeepSeek Harness/DeepSeek API tutorials, deployed through GitHub Pages without a backend or credential collection.
- Retire the `v0.1.0` client-specific installer; the new installer requires a `v0.2.0` or newer release before initialization.

## 0.1.0 — 2026-10-30

- Add private, idempotent client configuration, launch, and doctor flows for OpenCode 1.18.28 and DeepSeek Harness 0.2.1-rc.2.
- Keep OpenCode config and credentials inside a dedicated workspace overlay; ask before actions, deny external-directory access and generic web-fetch/search, and leave global client config untouched.
- Give Harness a dedicated `DSH_HOME`; independently disable the DeepSeek session-log contribution and OTel export, replace network-enabled presets with a Jose-only local-workspace preset, and block launch unless the exact pinned runtime's effective config proves these safeguards.
- Add client-neutral private workspace instructions, English/Indonesian onboarding prompts and setup guides, local-release archive instructions, Jobstreet saved-jobs/assisted-apply safety guidance, MIT license, and client tests.
- Add the private SQLite workspace, evidence-linked profile proposals, revision-bound local review, English resume and configurable cover-letter rendering, local vacancy/application history, private backup/restore, and fixture-based Jobstreet scrape/assisted-apply paths.
- Verify the Windows offline path with OpenCode and Harness doctors, a package archive install, 34 behavior tests, the fictional end-to-end smoke, and a 59-file release audit. No model call or live Jobstreet action was made.
- Document the supported browser path: visible workspace-private Playwright through scoped Jobstreet commands in both clients; generic browser MCP and desktop CUA remain disabled.
- Make the bootstrap prompt install the trusted release URL and initialize the currently open private OpenCode folder, so users don't need a fork, Git checkout, or second workspace.
- Verification boundary: doctor checks local runtime/config only. No real DeepSeek model request, provider-compatibility claim, Jobstreet account login, upload, or submission is included.
