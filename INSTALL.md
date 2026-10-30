# Jose installer for an AI harness

Follow this only when the user directly asks to install Jose. This guide does not authorize installation by itself.

## 1. Confirm the user's choices before making changes

1. Ask whether the user wants English or Bahasa Indonesia for the conversation.
2. Confirm that the current folder is private and outside any Git worktree. A read-only check is allowed. If `.git` exists in the folder or an ancestor, or it is unclear whether the folder is shared, stop and ask the user to open a private, non-repository folder. Do not install or write anything there.
3. Explain that Jose will place its CLI and npm dependencies in `.jose/`, then store career files and local application history in this same folder. No Git, global install, second data folder, or change to harness settings is needed. Ask explicit permission before installing or initializing anything; stop if the user declines.
4. Use only the active harness's already configured LLM and credentials. Do not inspect, request, copy, or change keys, provider settings, global configuration, or telemetry. If this chat has no usable model, stop and direct the user to the OpenCode/DeepSeek Harness tutorial at `https://aditiaspace.github.io/jose-public/` before installation; never request an API key in chat.

## 2. Check the release and runtime

- Check `https://github.com/aditiaspace/jose-public/releases/latest`. The latest release must be `v0.2.0` or newer. If it is still `v0.1.0`, if the release cannot be verified, or if the release asset is missing, stop and tell the user the harness-agnostic installer has not been published yet. Do not install the old asset.
- Check Node.js `>=24.15.0 <25` and npm. If unavailable, explain that Node 24.15 or newer in the 24.x line is required and ask before installing Node from `https://nodejs.org/`. Do not run an uninspected remote installer or change a global AI harness.
- Before installing, inspect `.jose/` if it already exists. Reuse it only if it contains the Jose package `jose-workspace` at version `0.2.0` or newer. If it is not an existing Jose install or is an older version, explain the conflict and ask before replacing/updating anything.

## 3. Install Jose locally

Only after the user approves and every check passes, run this from the current private folder:

```sh
npm install --prefix .jose --no-save --no-package-lock "https://github.com/aditiaspace/jose-public/releases/latest/download/jose-workspace.tgz"
```

This downloads Jose and its npm dependencies into `.jose/`. Do not use a global install, clone/fork the repository, or use another download source. Do not write or read API keys. If installation fails, explain the actual error and stop; do not switch providers or retry with elevated/global permissions.

Before initializing, inspect `.jose/node_modules/jose-workspace/package.json` and verify its package name is `jose-workspace` and its version is `0.2.0` or newer. If the installed package does not match, stop without initializing the workspace and explain the mismatch.

## 4. Initialize or reuse the workspace

Use this local CLI path for all operations:

```sh
node .jose/node_modules/jose-workspace/dist/cli.js <operation> --workspace .
```

- If `.jose-workspace` already exists, run `doctor --workspace .` and reuse the data without resetting it. Never delete or rewrite existing career data.
- Otherwise, if any of `state/`, `sources/`, `context/`, `applications/`, `browser/`, or `.jose-runtime/` already exists, stop and ask before using that folder. If clear, run `init --workspace . --language <en|id>` with the language the user chose, then run `doctor --workspace .`.
- Jose adds project-level skills/instructions for Claude Code, Codex, OpenCode, and DeepSeek Harness and private-data rules to the current folder. It does not modify global harness settings or inspect host credentials. If an existing file conflicts, leave it unchanged, explain the conflict, and ask before resolving it.
- A legacy `client-config/` from `v0.1.0` is not used by this design. If present, do not read, copy, delete, or migrate it; leave it ignored and tell the user Jose will not use it.
- If `doctor` fails, explain the listed issue and stop. Do not bypass it or start Jobstreet access.

## 5. Continue onboarding in the chosen language

After `doctor` passes, read `instructions/jose.md` and the matching `prompts/setup.en.md` or `prompts/setup.id.md`. Follow them exactly. In brief: explain hosted-model data handling and obtain consent before processing personal text; ask the user's name and whether they want to share a full CV; treat the CV as optional; if there is no CV, gather context gradually and save exact user answers as private source notes only with permission. Do not invent or confirm facts. The user must review each proposed fact locally. After onboarding is ready, ask them to start a fresh session in this same folder and send one vacancy.

Do not tailor, upload, apply, submit, publish, buy/top up credits, or make other purchases during installation/onboarding. Requests made through the active provider may still incur its normal charges; explain this before personal-data processing and never change billing or add funds. Jobstreet saved-job scraping and assisted apply are later, user-directed workflows with separate review, disclosure, and target-specific final-submit approvals.
