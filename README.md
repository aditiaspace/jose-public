# Jose public workspace

Jose is a personal, local job-search workspace and agent skill—not a shared SaaS tracker. It uses the AI model and credentials already configured in your current harness. Your career facts, CV, drafts, and application history stay in the private folder you open.

> **Release:** `v0.1.0` is the obsolete client-specific preview. Use the harness-agnostic `v0.2.0` or newer; the installer verifies the release and stops if it is unavailable.

- [English setup guide](SETUP.md) · [Panduan Bahasa Indonesia](SETUP.id.md) · [Getting-started page](https://aditiaspace.github.io/jose-public/)
- Conversation language: English or Bahasa Indonesia. Generated CVs and resumes are always English; cover letters default to English.
- Supported project-level skill/instruction entrypoints: Claude Code, Codex, OpenCode, and DeepSeek Harness. The active harness supplies the model, credentials, and permissions.
- No GitHub account, fork, Git repository, Jose account, global client install, API key, or second data folder is required.

## Before installing

If your agent already works, keep using it—Jose does not select or install a model. If it has no usable LLM, the getting-started page explains the optional OpenCode or DeepSeek Harness path with DeepSeek API. Prices and provider setup can change, so the page links to the official sources instead of hard-coding prices.

## Install

Open a **private folder that is not a shared code project** in your agent, then paste this short prompt:

```text
Install Jose in this private folder by following https://raw.githubusercontent.com/aditiaspace/jose-public/main/INSTALL.md.
```

The installer places Jose's CLI under `.jose/` in this same folder. Career data and local application history are stored alongside it; nothing requires Git. It must not modify global harness settings or read, copy, or store host credentials. The installer checks that the current release is `v0.2.0` or newer before initializing.

## Privacy and workflow

Before processing a CV or other personal career text with a hosted model, Jose explains that selected content may leave the device and asks for consent. If you have a CV, you can share it after that explanation; if not, onboarding gathers context gradually from your own answers. Facts stay unconfirmed until you review them in Jose's local review page. Never accept invented employers, dates, metrics, skills, or achievements.

Send a vacancy → review and revise the English-tailored draft → apply yourself and tell Jose what happened. Jose records only what you report or what its approved Jobstreet workflow visibly confirms. Jobstreet saved-job scraping and assisted apply remain available through Jose's dedicated visible Playwright flow; login, CAPTCHA/OTP, factual answers, disclosure approval before upload, and a separate target-specific final-submit approval stay with you. Generic browser MCP and whole-desktop computer-use tools are not enabled.

Hosted model requests are still sent to the provider you chose; Jose cannot guarantee that provider's retention or deletion practices. The local doctor checks the workspace files and Node version only—it does not test a model, sign into Jobstreet, upload a file, or submit an application. Live model and Jobstreet behavior remain unverified.
