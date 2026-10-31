import assert from 'node:assert/strict';
import test from 'node:test';
import { findChromiumRuntime, systemChromiumCandidates } from '../dist/browser-runtime.js';

test('finds bundled and system Chromium candidates without touching the filesystem',()=>{
  const bundledPath='/managed/playwright/chromium';
  const systemPath=systemChromiumCandidates('linux',{})[2];
  const runtime=findChromiumRuntime(path=>path===bundledPath||path===systemPath,bundledPath,'linux',{});
  assert.deepEqual(runtime,{bundledPath,systemPath});
});

test('returns no executable when neither managed nor system browsers exist',()=>{
  assert.deepEqual(findChromiumRuntime(()=>false,'/missing/playwright/chromium','linux',{}),{});
});
