import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { clientDoctor, configureClient } from '../dist/clients.js';
import { initWorkspace } from '../dist/workspace.js';

function makeWorkspace(t, language = 'en', client = 'opencode') {
  const temp = mkdtempSync(join(tmpdir(), 'jose-public-client-test-'));
  const root = join(temp, 'private-workspace');
  const ws = initWorkspace(root, language, client);
  t.after(() => {
    ws.close();
    rmSync(temp, { recursive: true, force: true });
  });
  return ws;
}

test('client setup is idempotent, preserves user entrypoint text, and supports switching clients', t => {
  const ws = makeWorkspace(t, 'id', 'opencode');
  writeFileSync(ws.path('AGENTS.md'), '# User-owned workspace note\n');

  configureClient(ws, 'opencode');
  const firstLoader = readFileSync(ws.path('AGENTS.md'), 'utf8');
  const firstConfig = readFileSync(ws.path('client-config/opencode/opencode.json'), 'utf8');
  assert.ok(firstLoader.startsWith('# User-owned workspace note\n'));
  assert.equal(firstLoader.match(/<!-- JOSE:BEGIN -->/g)?.length, 1);
  assert.match(firstLoader, /context\/current\.json/);
  assert.ok(readFileSync(ws.path('client-config/prompts/setup.id.md'), 'utf8').includes('Bahasa Indonesia'));
  assert.ok(readFileSync(ws.path('client-config/prompts/setup.en.md'), 'utf8').includes('English'));

  configureClient(ws, 'opencode');
  assert.equal(readFileSync(ws.path('AGENTS.md'), 'utf8'), firstLoader);
  assert.equal(readFileSync(ws.path('client-config/opencode/opencode.json'), 'utf8'), firstConfig);

  const config = JSON.parse(firstConfig);
  assert.equal(config.share, 'disabled');
  assert.deepEqual(config.enabled_providers, ['deepseek']);
  assert.equal(config.permission['*'], 'ask');
  assert.equal(config.permission.external_directory['*'], 'deny');
  assert.equal(config.permission.webfetch, 'deny');
  assert.equal(config.permission.websearch, 'deny');
  assert.equal(config.agent.build.permission['*'], 'ask');
  assert.equal(config.agent.build.permission.webfetch, 'deny');
  assert.equal(JSON.stringify(config).includes('"allow"'), false);

  configureClient(ws, 'harness');
  assert.equal(readFileSync(ws.path('AGENTS.md'), 'utf8'), firstLoader);
  assert.equal(readFileSync(ws.path('client-config/opencode/opencode.json'), 'utf8'), firstConfig);
  const overlay = readFileSync(ws.path('client-config/harness/cordis.patch.yml'), 'utf8');
  assert.match(overlay, /id: session-log-deepseek[\s\S]*?enabled: false/);
  assert.match(overlay, /id: session-telemetry-otel[\s\S]*?mode: DISABLED/);
  assert.match(overlay, /id: agent-preset-registry[\s\S]*?default: jose/);
  assert.match(overlay, /id: preset-jose[\s\S]*?id: tool-fs-search/);
  assert.match(overlay, /id: preset-standard\s+disabled: true/);
  assert.match(overlay, /id: tool-web\s+disabled: true/);
  assert.doesNotMatch(overlay, /name: ['"]@deepseek-ai\/dsh-tool-web['"]/);
  assert.match(overlay, /projectRootMarkers:[\s\S]*?\.jose-workspace/u);
  assert.equal(existsSync(ws.path('client-config/harness-agents')), true);
  assert.equal(existsSync(ws.path('client-config/harness-agents/AGENTS.md')), false);
});

test('configuration refuses to overwrite unrelated client files', t => {
  const ws = makeWorkspace(t);
  const configPath = ws.path('client-config/opencode/opencode.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, '{"tui":{"scrollSpeed":3}}\n');

  assert.throws(() => configureClient(ws, 'opencode'), /Refusing to overwrite existing workspace file/);
  assert.equal(readFileSync(configPath, 'utf8'), '{"tui":{"scrollSpeed":3}}\n');
});

test('doctor fails closed when the pinned client executable is unavailable and never returns inherited API keys', t => {
  const ws = makeWorkspace(t, 'en', 'harness');
  configureClient(ws, 'harness');
  const path = process.env.PATH;
  const key = process.env.DEEPSEEK_API_KEY;
  const secretSentinel = 'not-a-real-key-test-sentinel';
  try {
    const emptyBin = ws.path('empty-bin');
    mkdirSync(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;
    process.env.DEEPSEEK_API_KEY = secretSentinel;
    const result = clientDoctor(ws);
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.issues), /0\.2\.1-rc\.2/);
    assert.equal(JSON.stringify(result).includes(secretSentinel), false);
    const privacy = result.privacy;
    assert.equal(privacy.verifiedFromEffectiveConfig, false);
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    if (key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = key;
  }
});
