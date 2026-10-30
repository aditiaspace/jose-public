# Jose public workspace

Jose is a private, local job-search workspace that guides an agent through evidence-backed CV tailoring and human-controlled applications. The installer uses the private folder already open in OpenCode as the workspace. Users do not need to manage source code, create an account, or choose a second data folder.

- [English setup guide](SETUP.md) · [Panduan setup Bahasa Indonesia](SETUP.id.md)
- Target client versions: OpenCode **1.18.28** and DeepSeek Harness **@deepseek-ai/dsh 0.2.1-rc.2**. Live DeepSeek sessions remain unverified.
- Conversation language is English or Bahasa Indonesia; generated CVs and resumes are always English. Cover letters default to English; portal answers follow the user's choices.
- Local sources, SQLite state, context, generated files, browser profile, and client credentials live in the private workspace. Do not use the public Jose installation directory as that workspace.
- Windows is the first verified platform. macOS/Linux paths are designed for portability but are not yet advertised as verified.

## Privacy and limits

OpenCode is launched with a workspace-private HOME/XDG data/config overlay, a private non-secret `opencode.json`, conversation sharing disabled, a DeepSeek-only provider allowlist, ask-before-action permissions, denied external-directory access, and web-fetch/search denied. Harness is launched with a dedicated `DSH_HOME`; its checked overlay disables both the DeepSeek session-log contribution and separate OpenTelemetry export, disables generic web tools/providers, and leaves only Jose's local-workspace preset. `jose doctor` checks the exact client version and effective privacy configuration before launch; it fails closed if it cannot prove the required settings. A doctor result is not a model/provider compatibility test.

**Hosted-provider data leaves this device.** Once you use a hosted model, prompts and selected CV/vacancy text, context, drafts, and tool results may be sent to that provider and are subject to its policies. Harness's two extra logging/export channels are disabled, but ordinary model requests still leave the device. Jose never asks you to put an API key in chat or command arguments; enter it through the client's interactive credential control. Jose does not choose a model or claim that a particular provider/model accepts your key.

Jose's Jobstreet flow uses a dedicated visible Playwright browser through explicit Jose commands, shared by both clients. Saved-job scraping and assisted application are implemented, but live portal behavior remains unverified. The user handles login, CAPTCHA/OTP, and every factual answer; approves disclosure before upload; and gives a separate final approval for each target submission. Jose must not change the primary CV, profile, visibility, or boosts. A draft or upload is not an application report. Generic browser MCP and desktop computer-use tools are not enabled.

## Installation

Open a private folder in OpenCode and paste this prompt:

```text
Install Jose from https://github.com/aditiaspace/jose-public/releases/latest/download/jose-workspace.tgz in this private folder OpenCode currently has open. Use this same folder for my Jose workspace; do not create a second data folder. If it is part of a shared code project, stop and ask me to open a private folder. Check Node.js 24.15–24.x and explain/ask before installing or changing anything globally. Use OpenCode by default; ask if I want Harness instead. Install only from this release link, initialize and run doctor in this current folder, then launch Jose here. Do not ask for my CV or API key in this setup chat. In the new Jose session, explain hosted-model data handling before reading my CV, then guide onboarding and ask me to review each fact. After onboarding, ask me to start a fresh session in this same folder and send one vacancy. Never upload, apply, or submit without separate approval.
```

For the complete English or Bahasa Indonesia instructions, use [bootstrap.en.md](prompts/bootstrap.en.md) or [bootstrap.id.md](prompts/bootstrap.id.md).

## Verification status

`jose doctor` verifies local client version/configuration and, for Harness, inspects the actual composed DSH config without a model request. It does not verify DeepSeek model compatibility, make a paid/model call, sign in to Jobstreet, or submit an application. Live provider and portal behavior must be validated by the user in their own account after reading the privacy and approval steps.
