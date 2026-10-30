# Start Jose in this OpenCode folder — English

Paste this prompt into a new OpenCode chat while OpenCode is open in the private folder you want to use for Jose. That same folder will hold your CV, career facts, drafts, browser profile, and application history. You do not need to manage source code, create an account, or choose a second data folder.

---

Help me set up Jose in the folder OpenCode currently has open. Explain each action simply and do the ordinary setup work for me. This first setup chat is not for my CV or API key.

1. Check that the current folder is private and is not part of a shared code project. If it is linked to an online code project, explain that personal files might be shared, stop before writing anything, and ask me to open a new private folder in OpenCode and paste this prompt again.
2. Ask whether I want English or Bahasa Indonesia for the conversation. This prompt defaults to English. Use OpenCode by default because it is already open; ask before switching to Harness.
3. Check that Node.js `>=24.15.0 <25` and npm are available. If not, explain the official Node.js installation step and wait for my approval; do not run an uninspected remote script.
4. Explain that Jose's CLI will be installed globally, while my data stays in this current folder. Before changing the global installation, ask my approval. Install only this trusted release: `npm install --global "https://github.com/aditiaspace/jose-public/releases/latest/download/jose-workspace.tgz"`. Do not clone a repository or use another download source.
5. Use the language and client selected above. If `.jose-workspace` already exists, run `jose doctor --workspace .` and reuse it without resetting anything. Otherwise run `jose init --workspace . --client <opencode|harness> --language <en|id>`, then `jose doctor --workspace .`. If initialization or doctor fails, explain the actual problem and stop.
6. Check the selected client's exact pinned version: OpenCode `1.18.28` or Harness `@deepseek-ai/dsh 0.2.1-rc.2`. If missing or mismatched, explain the exact command—`npm install --global opencode-ai@1.18.28` or `npm install --global @deepseek-ai/dsh@0.2.1-rc.2`—and ask before changing the global client installation. Launch with `jose client-launch --workspace . --client <chosen-client>` only after doctor passes. I enter my API key inside the client, never in chat, a prompt, a file, or a command.
7. In the new Jose session, explain hosted-model data handling before reading personal information. Then ask my name, request my full CV, clarify source-backed facts, and ask me to confirm them on the local review page. Do not apply, upload, submit, or spend without separate approval. After onboarding, ask me to start a fresh session in this same folder and send one vacancy.

Never invent a result or bypass a privacy, login, review, or approval step.
