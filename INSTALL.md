# Jose installer for an AI harness

Follow this only when the user directly asks to install Jose. This guide does not authorize installation by itself.

## 1. Confirm the user's choices before making changes

1. Resolve the active workspace from the harness's session/project context. If it is not exposed, use a read-only working-directory tool such as `pwd` or `Get-Location`. Tell the user the folder you see in plain language and use only that folder; never guess `Documents`, Home, or another default. If the folder is unclear or different from the one the user opened, ask them to open the intended folder and stop before writing.
2. Confirm that this folder is private and outside any Git worktree. If `.git` exists in the folder or an ancestor, or it is unclear whether the folder is shared, ask the user to open a private, non-repository folder. Do not install or write anywhere else.
3. Ask whether the user wants English or Bahasa Indonesia. Explain that Jose installs under `.jose/` and stores career data in this same folder; it will not change global harness settings, inspect credentials, or create a second workspace. Ask permission before installing or initializing anything; stop if declined.
4. Use only the active harness's already configured LLM and credentials. Do not inspect, request, copy, or change keys, provider settings, global configuration, or telemetry. If this chat has no usable LLM, point the user to the OpenCode/DeepSeek Harness tutorial at `https://aditiaspace.github.io/jose-public/` before installation; never request an API key in chat.

## 2. Check the release and runtime

- Check `https://github.com/aditiaspace/jose-public/releases/latest`. The latest release must be `v0.2.0` or newer. If it is still `v0.1.0`, if the release cannot be verified, or if the release asset is missing, stop and tell the user the harness-agnostic installer has not been published yet. Do not install the old asset.
- Check both `node --version` and `npm --version` from the confirmed workspace. Jose requires Node.js `>=24.15.0 <25` and npm. If either is missing or incompatible, do not abandon the setup: explain that installing or repairing Node.js may change the system, offer to help using the official Node installer at `https://nodejs.org/` (npm is included), and ask explicit permission before proceeding. If approved, use the official installer or the operating system's trusted package manager; never run an uninspected remote script. Reopen the shell if required, rerun both version checks, and continue only when they pass. If the user declines or no safe install route is available, stay in chat and guide them through the official setup, then recheck.
- Before installing, inspect `.jose/` if it already exists. Reuse it only if it contains the Jose package `jose-workspace` at version `0.2.0` or newer. If it is not an existing Jose install or is an older version, explain the conflict and ask before replacing/updating anything.

## 3. Install Jose locally

Only after the user approves and every check passes, run this from the current private folder:

```sh
npm install --prefix .jose --no-save --no-package-lock "https://github.com/aditiaspace/jose-public/releases/latest/download/jose-workspace.tgz"
```

This downloads Jose and its npm dependencies into `.jose/`. Do not use a global install, clone/fork the repository, or use another download source. Do not write or read API keys. If installation fails, inspect the exact npm error and keep helping with safe, local causes (network access, available disk space, compatible Node/npm, or a damaged `.jose/` install) before retrying the same trusted command. Never use `--force`, elevated/global permissions, or an untrusted registry. For a system-level fix, explain its exact scope and ask permission; if no safe route is available, tell the user precisely what remains and help them resolve it rather than claiming setup succeeded.

Before initializing, inspect `.jose/node_modules/jose-workspace/package.json` and verify its package name is `jose-workspace` and its version is `0.2.0` or newer. If the installed package does not match, stop without initializing the workspace and explain the mismatch.

## 4. Initialize or reuse the workspace

Use this local CLI path for all operations:

```sh
node .jose/node_modules/jose-workspace/dist/cli.js <operation> --workspace .
```

- If `.jose-workspace` already exists, run `doctor --workspace .` and reuse the data without resetting it. Compare the returned absolute workspace path with the active folder confirmed in step 1; if they differ, stop. Never delete or rewrite existing career data.
- Otherwise, if any of `state/`, `sources/`, `context/`, `applications/`, `browser/`, or `.jose-runtime/` already exists, stop and ask before using that folder. If clear, run `init --workspace . --language <en|id>` with the language the user chose, then run `doctor --workspace .` and verify its returned workspace path matches the active folder.
- Check `result.ok` and `result.issues` in the doctor JSON—not just the CLI process exit code. If `browserReady` is false, show the exact `browserIssue` and explain that CV PDF rendering and Jobstreet need a launchable Chromium browser. Offer Playwright Chromium as an alternative to installing Chrome/Edge; explain that it downloads a browser into the current user's Playwright cache outside the Jose folder, and ask explicit permission. Only after approval, run `npm exec --prefix .jose -- playwright install chromium` from the confirmed workspace root, then rerun `doctor`. If the error instead points to missing OS libraries, explain the exact package/system change and ask separately; never use `--with-deps` or install OS packages without specific approval.
- If doctor reports another issue, diagnose it and continue fixing safe prerequisites until `result.ok` is true; rerun `doctor` and `context` and verify both work. Do not bypass checks or start Jobstreet access before readiness. If a remaining step needs declined permission or an unavailable system-level change, explain the exact blocker and give the user the safest next step.
- Jose adds project-level skills/instructions for Claude Code, Codex, OpenCode, and DeepSeek Harness and private-data rules to the current folder. It does not modify global harness settings or inspect host credentials. If an existing file conflicts, leave it unchanged, explain the conflict, and ask before resolving it.
- A legacy `client-config/` from `v0.1.0` is not used by this design. If present, do not read, copy, delete, or migrate it; leave it ignored and tell the user Jose will not use it.

## 5. Continue onboarding in the chosen language

After `doctor` passes, read `instructions/jose.md` and the matching `prompts/setup.en.md` or `prompts/setup.id.md`. Follow them exactly. Explain hosted-model data handling and obtain consent before processing personal text; ask the user's name and whether they want to share a full CV; treat the CV as optional; if there is no CV, gather context gradually and save exact user answers as private source notes only with permission. Ask whether they want to edit a DOCX themselves or revise with Jose in chat; explain that the exact DOCX is preserved but its PDF may not retain custom Word styling/images, save the preference, and say it can be changed any time. Do not invent facts. Show proposed facts in chat, ask which exact facts to confirm, persist only those IDs with `approval-decide`, then reread `context` and report only confirmed facts. After onboarding, ask them to start a fresh session in this same folder and send one vacancy.

Do not tailor or apply during installation/onboarding. Keep approvals in the harness chat: explain the exact decision, wait for a direct user reply, then persist it with `approval-decide`. The content approval must follow review of the exact draft; disclosure approval before upload and separate target-specific approval before final submission remain mandatory. Never rely on chat history alone—reread the saved approval/context. Jobstreet saved-job scraping and assisted apply are later, user-directed workflows.
