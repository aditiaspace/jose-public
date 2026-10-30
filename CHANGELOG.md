# Changelog

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
