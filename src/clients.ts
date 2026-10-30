import { z } from 'zod';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Client } from './contracts.js';
import { INSTALL_ROOT } from './workspace.js';
import type { Workspace } from './workspace.js';
import { atomic } from './util.js';

const START = '<!-- JOSE:BEGIN -->';
const END = '<!-- JOSE:END -->';
const DSH_VERSION = '0.2.1-rc.2';
const OPENCODE_VERSION = '1.18.28';
const DSH_PATCH = 'client-config/harness/cordis.patch.yml';
const OPEN_CONFIG = 'client-config/opencode/opencode.json';
const OPEN_AUTH = 'client-config/opencode/xdg-data/opencode/auth.json';
const DSH_RUNTIME = 'client-config/harness-runtime.json';
const DSH_RUNTIME_SCHEMA = z.object({ pid: z.number().int().positive(), port: z.number().int().positive().max(65535), workspaceId: z.string().min(1) }).strict();

function asset(relative: string): string {
  return readFileSync(resolve(INSTALL_ROOT, relative), 'utf8');
}

function ensureExactFile(ws: Workspace, relative: string, content: string): void {
  const path = ws.path(relative);
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === content) return;
    throw new Error(`Refusing to overwrite existing workspace file ${relative}; move or review it before configuring Jose.`);
  }
  ws.write(relative, content);
}

function loaderBlock(ws: Workspace): string {
  return `${START}
## Jose private workspace

Read \`client-config/jose-instructions.md\` before responding. At the beginning of every session, read \`context/current.json\` if it exists and run \`jose context --workspace .\` from the private workspace root to refresh the confirmed context. If onboarding is not ready, read \`client-config/prompts/setup.en.md\` when the persisted language is \`en\`, or \`client-config/prompts/setup.id.md\` when it is \`id\`.

Use the installed \`jose\` CLI for all workspace state changes. Do not edit SQLite, context snapshots, profile facts, approvals, materials, or application records directly. Never ask for or put an API key in chat, a prompt, a JSON input file, a command argument, or a log; use the client's interactive credential flow. Converse in the persisted language, explain every tool error and confirmation in that language, and preserve exact technical diagnostics when useful. The user can change language with \`jose language-set --language en\` or \`jose language-set --language id\`. Keep every generated CV/resume in English; default cover letters to English unless the user requests another language.

The operator must be told that hosted-provider prompts and selected workspace content leave this device before any personal CV content is sent. Follow the explicit human review, disclosure, upload, and per-target submit gates in the neutral instructions.
${END}`;
}

function ensureLoader(ws: Workspace): void {
  const relative = 'AGENTS.md';
  const path = ws.path(relative);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  const loader = loaderBlock(ws);
  if (start === -1 && end === -1) {
    const next = existing ? `${existing}${existing.endsWith('\n') ? '\n' : '\n\n'}${loader}\n` : `${loader}\n`;
    ws.write(relative, next);
    return;
  }
  if (start === -1 || end === -1 || end < start || existing.indexOf(START, start + START.length) !== -1 || existing.indexOf(END, end + END.length) !== -1) {
    throw new Error('AGENTS.md contains incomplete or repeated Jose markers; it was left unchanged.');
  }
  const oldEnd = end + END.length;
  const next = `${existing.slice(0, start)}${loader}${existing.slice(oldEnd)}`;
  if (next !== existing) ws.write(relative, next);
}

function validateClient(client: Client): void {
  if (client !== 'opencode' && client !== 'harness') throw new Error('Client must be opencode or harness.');
}

export function configureClient(ws: Workspace, client: Client): void {
  validateClient(client);
  ensureExactFile(ws, 'client-config/jose-instructions.md', asset('instructions/neutral.md'));
  ensureExactFile(ws, 'client-config/prompts/setup.en.md', asset('prompts/setup.en.md'));
  ensureExactFile(ws, 'client-config/prompts/setup.id.md', asset('prompts/setup.id.md'));
  ensureLoader(ws);
  if (client === 'opencode') ensureExactFile(ws, OPEN_CONFIG, asset('clients/opencode.json'));
  else {
    ensureExactFile(ws, DSH_PATCH, asset('clients/harness-privacy.yml'));
    for(const relative of ['client-config/harness-home','client-config/harness-agents']) {
      const path=ws.path(relative);
      if(!existsSync(path))mkdirSync(path,{recursive:true,mode:0o700});
    }
  }
}

function privateEnvironment(ws: Workspace, client: Client): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)/i.test(key)) delete env[key];
  }
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.OPENCODE_AUTH_CONTENT;
  if (client === 'harness') {
    env.DSH_HOME = ws.path('client-config/harness-home');
    env.DSH_AGENTS_HOME = ws.path('client-config/harness-agents');
    env.DSH_TELEMETRY_MODE = 'DISABLED';
    env.DSH_TELEMETRY_DISABLED = '1';
    env.DSH_PERMISSION_MODE = 'workspace-write';
  } else {
    const home = ws.path('client-config/opencode/home');
    env.HOME = home;
    env.USERPROFILE = home;
    env.APPDATA = ws.path('client-config/opencode/appdata/roaming');
    env.LOCALAPPDATA = ws.path('client-config/opencode/appdata/local');
    env.XDG_CONFIG_HOME = ws.path('client-config/opencode/xdg-config');
    env.XDG_DATA_HOME = ws.path('client-config/opencode/xdg-data');
    env.XDG_STATE_HOME = ws.path('client-config/opencode/xdg-state');
    env.XDG_CACHE_HOME = ws.path('client-config/opencode/xdg-cache');
    env.OPENCODE_CONFIG = ws.path(OPEN_CONFIG);
    delete env.OPENCODE_CONFIG_DIR;
    delete env.OPENCODE_CONFIG_CONTENT;
    delete env.OPENCODE_AUTH_CONTENT;
    delete env.OPENCODE_TEST_HOME;
    delete env.OPENCODE_DB;
    delete env.OPENCODE_WORKSPACE_ID;
    delete env.OPENCODE_PERMISSION;
    delete env.OPENCODE_TUI_CONFIG;
    delete env.OPENCODE_MODELS_URL;
    delete env.OPENCODE_MODELS_PATH;
    delete env.OPENCODE_FAKE_VCS;
    env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
    env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  }
  return env;
}

function hasProjectEnv(ws: Workspace): boolean {
  try {
    return readdirSync(ws.root).some(name => name.toLowerCase() === '.env' || name.toLowerCase().startsWith('.env.'));
  } catch {
    return true;
  }
}
type Executable = { command: string; args: string[]; windowsVerbatimArguments: boolean };
function executable(command:string,args:string[]):Executable {
  if(process.platform!=='win32'||command!=='dsh') return {command,args,windowsVerbatimArguments:false};
  if(args.some(arg=>/[&|<>^%!"\r\n]/.test(arg))) throw new Error('Harness command contains an unsafe Windows shell argument.');
  // dsh is an npm .cmd shim on Windows. Quote each fixed argument and bypass Node's
  // second quoting pass; shell metacharacters and CMD variable expansion are rejected.
  const commandLine=[command,...args.map(arg=>`"${arg}"`)].join(' ');
  return {command:process.env.ComSpec??join(process.env.SystemRoot??'C:\\Windows','System32','cmd.exe'),args:['/d','/s','/c',commandLine],windowsVerbatimArguments:true};
}

function runCheck(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): { ok: boolean; output: string; stdout: string; stderr: string } {
  const invocation=executable(command,args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '', output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function parseVersion(output: string): string | null {
  return output.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\s|$)/)?.[1] ?? null;
}

function openCodeCredential(ws: Workspace): 'present' | 'missing' | 'invalid' {
  const path = ws.path(OPEN_AUTH);
  if (!existsSync(path)) return 'missing';
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
    return Object.entries(value).some(([provider, auth]) => {
      if (!/deepseek/i.test(provider) || !auth || typeof auth !== 'object' || Array.isArray(auth)) return false;
      const item = auth as Record<string, unknown>;
      return item.type === 'api' && typeof item.key === 'string' && item.key.length > 0;
    }) ? 'present' : 'missing';
  } catch {
    return 'invalid';
  }
}

function dumpRows(output: string): { id: string; row: string }[] {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const starts: { index: number; indent: number; id: string }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(\s*)-\s+id:\s*([A-Za-z0-9_.-]+)\s*$/);
    if (match) starts.push({ index, indent: match[1].length, id: match[2] });
  }
  if (starts.length === 0) return [];
  const rootIndent = Math.min(...starts.map(start => start.indent));
  const roots = starts.filter(start => start.indent === rootIndent);
  return roots.map((start, index) => ({
    id: start.id,
    row: lines.slice(start.index, roots[index + 1]?.index ?? lines.length).join('\n'),
  }));
}

function hasExpectedDshPrivacy(output: string): { sessionLogDisabled: boolean; otelDisabled: boolean; webFetchDisabled: boolean; webSearchDisabled: boolean; workspaceRootConfigured: boolean } {
  const entries = dumpRows(output);
  const rows = new Map(entries.map(entry => [entry.id, entry.row]));
  const named = (row: string | undefined, name: string) => Boolean(row && (row.includes(`name: '${name}'`) || row.includes(`name: \"${name}\"`)));
  const topLevelDisabled = (row: string | undefined) => {
    const indent = row?.match(/^(\s*)-\s+id:/)?.[1].length;
    return Boolean(row && indent !== undefined && new RegExp(`^ {${indent + 2}}disabled:\\s*true\\s*$`, 'm').test(row));
  };
  const disabled = (id: string, name: string) => {
    const row = rows.get(id);
    return named(row, name) && topLevelDisabled(row);
  };
  const session = rows.get('session-log-deepseek');
  const otel = rows.get('session-telemetry-otel');
  const registry = rows.get('agent-preset-registry');
  const josePreset = rows.get('preset-jose');
  const activePresets = entries.filter(entry => named(entry.row, '@deepseek-ai/dsh-agent-preset') && !topLevelDisabled(entry.row));
  const presetDisabled = ['standard', 'ptc', 'minimal', 'cordis'].every(id => disabled(`preset-${id}`, '@deepseek-ai/dsh-agent-preset'));
  const networkProvidersDisabled = disabled('web', '@deepseek-ai/dsh-web')
    && disabled('web-search-deepseek', '@deepseek-ai/dsh-web-search-deepseek')
    && disabled('web-deepseek-api', '@deepseek-ai/dsh-web-deepseek-api')
    && disabled('web-fetch-http', '@deepseek-ai/dsh-web-fetch-http')
    && disabled('tool-web', '@deepseek-ai/dsh-tool-web');
  const onlyJosePreset = activePresets.length === 1
    && activePresets[0].id === 'preset-jose'
    && Boolean(josePreset && /^\s+id:\s*jose\s*$/m.test(josePreset) && /^\s+plugins:\s*$/m.test(josePreset))
    && !/^\s+-\s+id:\s*tool-web\s*$/m.test(josePreset ?? '')
    && !josePreset?.includes('@deepseek-ai/dsh-tool-web');
  const sessionLogDisabled = Boolean(session && named(session, '@deepseek-ai/dsh-session-log-deepseek') && /^\s+config:\s*$/m.test(session) && /^\s+enabled:\s*false\s*$/m.test(session));
  const otelDisabled = Boolean(otel && named(otel, '@deepseek-ai/dsh-session-telemetry-otel') && /^\s+config:\s*$/m.test(otel) && /^\s+mode:\s*['\"]?DISABLED['\"]?\s*$/m.test(otel));
  const presetRegistryDefault = Boolean(registry && named(registry, '@deepseek-ai/dsh-agent-preset-registry') && /^\s+default:\s*jose\s*$/m.test(registry));
  const workspaceRootConfigured=Boolean(josePreset && /id:\s*agent-instructions[\s\S]*?projectRootMarkers:\s*[\s\S]*?-\s*\.jose-workspace(?:\s|$)/m.test(josePreset));
  const webToolsDisabled = presetDisabled && onlyJosePreset && presetRegistryDefault && networkProvidersDisabled;
  return { sessionLogDisabled, otelDisabled, webFetchDisabled: webToolsDisabled, webSearchDisabled: webToolsDisabled, workspaceRootConfigured };
}
function hasExpectedOpenCodePrivacy(output: string): { shareDisabled: boolean; deepseekOnly: boolean; shellAsk: boolean; externalAccessDenied: boolean; webToolsDenied: boolean } {
  const permissionSchema=z.object({
    '*':z.literal('ask'),
    webfetch:z.literal('deny'),
    websearch:z.literal('deny'),
    external_directory:z.object({'*':z.literal('deny')}).passthrough(),
  }).passthrough();
  const schema=z.object({
    share:z.literal('disabled'),
    enabled_providers:z.array(z.string()),
    permission:permissionSchema,
    agent:z.record(z.string(),z.object({permission:permissionSchema}).passthrough()),
  }).passthrough();
  try {
    const config=schema.parse(JSON.parse(output) as unknown);
    const agents=Object.values(config.agent);
    return {
      shareDisabled:config.share==='disabled',
      deepseekOnly:config.enabled_providers.length===1&&config.enabled_providers[0]==='deepseek',
      shellAsk:config.permission['*']==='ask'&&agents.length>0&&agents.every(agent=>agent.permission['*']==='ask'),
      externalAccessDenied:config.permission.external_directory['*']==='deny'&&agents.every(agent=>agent.permission.external_directory['*']==='deny'),
      webToolsDenied:config.permission.webfetch==='deny'&&config.permission.websearch==='deny'&&agents.every(agent=>agent.permission.webfetch==='deny'&&agent.permission.websearch==='deny'),
    };
  } catch {
    return {shareDisabled:false,deepseekOnly:false,shellAsk:false,externalAccessDenied:false,webToolsDenied:false};
  }
}


function inspectClient(ws: Workspace, client: Client): Record<string, unknown> {
  validateClient(client);
  const issues: string[] = [];
  const env = privateEnvironment(ws, client);
  const loaderPath = ws.path('AGENTS.md');
  const instructionPath = ws.path('client-config/jose-instructions.md');
  let loaderReady = false;
  let instructionsReady = false;
  let promptsReady = false;
  try {
    const existingLoader = readFileSync(loaderPath, 'utf8');
    const start = existingLoader.indexOf(START);
    const end = existingLoader.indexOf(END);
    loaderReady = start !== -1 && end > start && existingLoader.slice(start, end + END.length) === loaderBlock(ws);
    instructionsReady = readFileSync(instructionPath, 'utf8') === asset('instructions/neutral.md');
    promptsReady = readFileSync(ws.path('client-config/prompts/setup.en.md'), 'utf8') === asset('prompts/setup.en.md')
      && readFileSync(ws.path('client-config/prompts/setup.id.md'), 'utf8') === asset('prompts/setup.id.md');
  } catch {
    // A missing or unsafe private instruction file blocks startup.
  }
  if (!loaderReady || !instructionsReady || !promptsReady) issues.push('Private workspace instruction loader is missing or unsafe.');
  if (hasProjectEnv(ws)) issues.push('A root .env file exists; remove or relocate it before launch so client credentials cannot be inherited silently.');

  if (client === 'opencode') {
    let configReady = false;
    try {
      configReady = readFileSync(ws.path(OPEN_CONFIG), 'utf8') === asset('clients/opencode.json');
    } catch {
      // Missing or unsafe config blocks startup.
    }
    if (!configReady) issues.push('Private OpenCode permission config is missing or was changed; it was not overwritten.');
    const versionResult = runCheck('opencode', ['--version'], ws.root, env, 15000);
    const version = versionResult.ok ? parseVersion(versionResult.output) : null;
    if (version !== OPENCODE_VERSION) issues.push(`OpenCode ${OPENCODE_VERSION} is required; the installed runtime could not be verified.`);
    let shareDisabled=false,deepseekOnly=false,shellAsk=false,externalAccessDenied=false,webToolsDenied=false;
    if(configReady&&version===OPENCODE_VERSION) {
      const effective=runCheck('opencode',['debug','config'],ws.root,env,20000);
      if(effective.ok) ({shareDisabled,deepseekOnly,shellAsk,externalAccessDenied,webToolsDenied}=hasExpectedOpenCodePrivacy(effective.stdout));
      if(!effective.ok||!shareDisabled||!deepseekOnly||!shellAsk||!externalAccessDenied||!webToolsDenied) {
        issues.push('The effective OpenCode config did not prove private sharing disabled, DeepSeek-only provider access, ask permissions, and denied external/web tools; launch was blocked.');
      }
    }
    const credential = openCodeCredential(ws);
    if (credential === 'invalid') issues.push('The private OpenCode credential file is malformed; it was left unchanged.');
    return {
      client,
      ok: issues.length === 0,
      version,
      privacy: { instructionsReady, promptsReady, configReady, effectiveConfigChecked: configReady&&version===OPENCODE_VERSION, shareDisabled, deepseekOnly, shellAsk, globalConfigIsolated: true, projectConfigDisabled: true, externalAccessDenied, permissions: 'ask', webFetch: 'deny', webSearch: 'deny', noBroadAllow: true },
      credentials: { deepseekApiKeyConfigured: credential === 'present', store: 'workspace-private' },
      issues,
    };
  }

  let patchReady = false;
  try {
    patchReady = readFileSync(ws.path(DSH_PATCH), 'utf8') === asset('clients/harness-privacy.yml');
  } catch {
    // Missing or unsafe config blocks startup.
  }
  if (!patchReady) issues.push('Private Harness privacy overlay is missing or was changed; it was not overwritten.');
  let homeEnv = false;
  let agentsHomeIsolated = false;
  try {
    const home=ws.path('client-config/harness-home');
    const agents=ws.path('client-config/harness-agents');
    homeEnv=existsSync(resolve(home,'.env'))||existsSync(resolve(home,'AGENTS.md'));
    agentsHomeIsolated=env.DSH_AGENTS_HOME===agents&&existsSync(agents)&&!existsSync(resolve(agents,'.env'))&&!existsSync(resolve(agents,'AGENTS.md'));
  } catch {
    homeEnv=true;
  }
  if (homeEnv) issues.push('The dedicated Harness home contains a .env or AGENTS.md file; move it so user-global instructions or credentials cannot be inherited silently.');
  if (!agentsHomeIsolated) issues.push('The Harness instruction home is not isolated from global user instructions; re-run Jose setup.');

  const versionResult = runCheck('dsh', ['--version'], ws.root, env, 15000);
  const version = versionResult.ok ? parseVersion(versionResult.output) : null;
  if (version !== DSH_VERSION) issues.push(`DeepSeek Harness ${DSH_VERSION} is required; the installed runtime could not be verified.`);
  let sessionLogDisabled = false;
  let otelDisabled = false;
  let webFetchDisabled = false;
  let webSearchDisabled = false;
  let workspaceRootConfigured = false;
  if (patchReady && version === DSH_VERSION && !hasProjectEnv(ws) && !homeEnv && agentsHomeIsolated) {
    const dump = runCheck('dsh', ['--profile', 'web', '--patch', DSH_PATCH, '--dump-config'], ws.root, env, 90000);
    if (dump.ok) ({ sessionLogDisabled, otelDisabled, webFetchDisabled, webSearchDisabled, workspaceRootConfigured } = hasExpectedDshPrivacy(dump.output));
    if (!dump.ok || !sessionLogDisabled || !otelDisabled || !webFetchDisabled || !webSearchDisabled || !workspaceRootConfigured) {
      issues.push('The effective pinned Harness config did not prove both privacy opt-outs, disabled generic web tools, and the private workspace root marker; launch was blocked.');
    }
  }
  return {
    client,
    ok: issues.length === 0,
    version,
    privacy: {
      instructionsReady,
      promptsReady,
      patchReady,
      dedicatedHome: env.DSH_HOME,
      dedicatedAgentsHome: env.DSH_AGENTS_HOME,
      agentsHomeIsolated,
      sessionLogDisabled,
      otelDisabled,
      webFetchDisabled,
      webSearchDisabled,
      workspaceRootConfigured,
      verifiedFromEffectiveConfig: sessionLogDisabled && otelDisabled && webFetchDisabled && webSearchDisabled && workspaceRootConfigured,
      telemetryMode: env.DSH_TELEMETRY_MODE,
      telemetryDisabled: env.DSH_TELEMETRY_DISABLED,
      permissionMode: env.DSH_PERMISSION_MODE,
    },
    credentials: { status: 'not inspected', store: 'workspace-private DSH_HOME; use the client credential screen' },
    issues,
  };
}

export function clientDoctor(ws: Workspace): Record<string, unknown> {
  return inspectClient(ws, ws.settings().client);
}

function runInteractive(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
  const invocation=executable(command,args);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ exitCode: code, signal }));
  return promise;
}
function pause(ms:number):Promise<void> { const {promise,resolve}=Promise.withResolvers<void>();setTimeout(resolve,ms);return promise; }

async function availableLoopbackPort():Promise<number> {
  const server=createServer();
  const listening=Promise.withResolvers<number>();
  server.once('error',listening.reject);
  server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string'){listening.reject(new Error('Could not reserve a local port.'));return;}server.close(error=>error?listening.reject(error):listening.resolve(address.port));});
  return listening.promise;
}

function harnessReady(port:number):Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(500)})
    .then(response=>response.status===401)
    .catch(()=>false);
}

function terminateProcessTree(pid:number):void {
  if(process.platform==='win32') {
    const result=spawnSync('taskkill.exe',['/T','/F','/PID',String(pid)],{encoding:'utf8',windowsHide:true,timeout:10000});
    if(result.error)throw result.error;
    return;
  }
  try { process.kill(-pid,'SIGTERM'); } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ESRCH')return;
    try { process.kill(pid,'SIGTERM'); } catch(inner) { if((inner as NodeJS.ErrnoException).code!=='ESRCH')throw inner; }
  }
}

export async function stopClient(ws:Workspace):Promise<Record<string,unknown>> {
  const runtimePath=ws.path(DSH_RUNTIME);
  if(!existsSync(runtimePath))return {stopped:false,reason:'No workspace-owned Harness process was recorded.'};
  const data=DSH_RUNTIME_SCHEMA.parse(JSON.parse(readFileSync(runtimePath,'utf8')) as unknown);
  if(data.workspaceId!==ws.settings().workspaceId)throw new Error('Harness process metadata belongs to another workspace.');
  if(!await harnessReady(data.port)) {
    unlinkSync(runtimePath);
    return {stopped:false,reason:'The recorded local Harness listener is no longer present; stale metadata was removed without terminating a process.'};
  }
  terminateProcessTree(data.pid);
  unlinkSync(runtimePath);
  return {stopped:true,client:'harness'};
}

async function launchHarness(ws:Workspace):Promise<Record<string,unknown>> {
  const runtimePath=ws.path(DSH_RUNTIME);
  if(existsSync(runtimePath)) {
    const saved=DSH_RUNTIME_SCHEMA.parse(JSON.parse(readFileSync(runtimePath,'utf8')) as unknown);
    if(saved.workspaceId!==ws.settings().workspaceId)throw new Error('Harness process metadata belongs to another workspace.');
    let alive=true;try{process.kill(saved.pid,0);}catch{alive=false;}
    if(alive&&await harnessReady(saved.port))return {client:'harness',version:DSH_VERSION,alreadyRunning:true,origin:`http://127.0.0.1:${saved.port}`,startupTokenHidden:true};
    if(alive)throw new Error('A workspace-owned Harness process is running but its UI is not ready. Run jose client-stop before retrying.');
    unlinkSync(runtimePath);
  }
  const port=await availableLoopbackPort();
  const invocation=executable('dsh',['--profile','web','--patch',DSH_PATCH,'--host','127.0.0.1','--port',String(port)]);
  const child=spawn(invocation.command,invocation.args,{
    cwd:ws.root,env:privateEnvironment(ws,'harness'),detached:true,stdio:'ignore',shell:false,windowsHide:true,windowsVerbatimArguments:invocation.windowsVerbatimArguments,
  });
  child.unref();
  for(let i=0;i<300;i++) {
    if(child.exitCode!==null)throw new Error('DeepSeek Harness exited before its local UI was ready; no startup token was shown in chat.');
    if(await harnessReady(port)) {
      atomic(runtimePath,JSON.stringify({pid:child.pid,port,workspaceId:ws.settings().workspaceId}));
      return {client:'harness',version:DSH_VERSION,origin:`http://127.0.0.1:${port}`,openedInDefaultBrowser:true,startupTokenHidden:true};
    }
    await pause(100);
  }
  if(child.pid)terminateProcessTree(child.pid);
  throw new Error('DeepSeek Harness did not start its authenticated local UI within 30 seconds. Its startup output was kept out of chat.');
}

export async function launchClient(ws: Workspace, client: Client): Promise<Record<string, unknown>> {
  validateClient(client);
  configureClient(ws, client);
  const doctor = inspectClient(ws, client);
  if (doctor.ok !== true) throw new Error(`Client launch blocked: ${JSON.stringify(doctor.issues)}. Run jose doctor after correcting the reported issue.`);
  const env = privateEnvironment(ws, client);
  if (client === 'opencode') {
    if (openCodeCredential(ws) === 'missing') {
      const login = await runInteractive('opencode', ['auth', 'login'], ws.root, env);
      if (login.exitCode !== 0 || openCodeCredential(ws) !== 'present') {
        throw new Error('OpenCode did not save a direct DeepSeek API credential in this private workspace. No chat was started.');
      }
    }
    const result = await runInteractive('opencode', [], ws.root, env);
    return { client, version: OPENCODE_VERSION, credentialStore: 'workspace-private', ...result };
  }
  return launchHarness(ws);
}
