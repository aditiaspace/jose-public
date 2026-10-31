import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

export type ChromiumRuntime = { bundledPath?: string; systemPath?: string };

export function systemChromiumCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    const candidates = [
      join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    return candidates;
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge'];
}

export function findChromiumRuntime(
  exists: (path: string) => boolean = existsSync,
  bundledPath: string = chromium.executablePath(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ChromiumRuntime {
  const bundled = exists(bundledPath) ? bundledPath : undefined;
  const systemPath = systemChromiumCandidates(platform, env).find(exists);
  return { ...(bundled ? { bundledPath: bundled } : {}), ...(systemPath ? { systemPath } : {}) };
}

export async function checkChromiumRuntime():Promise<{ready:boolean;source:'playwright'|'system'|null;issue?:string}> {
  const {bundledPath,systemPath}=findChromiumRuntime();
  if(!bundledPath&&!systemPath)return {ready:false,source:null,issue:'No Chromium executable is available.'};
  const preferredExecutable=bundledPath?undefined:systemPath;
  try {
    const browser=await chromium.launch(preferredExecutable?{executablePath:preferredExecutable}:{});
    await browser.close();
    return {ready:true,source:bundledPath?'playwright':'system'};
  } catch(error) {
    if(bundledPath&&systemPath) {
      try {
        const browser=await chromium.launch({executablePath:systemPath});
        await browser.close();
        return {ready:true,source:'system'};
      } catch(fallbackError) {
        return {ready:false,source:null,issue:`Playwright Chromium and system Chrome/Edge could not be launched: ${String(fallbackError)}`};
      }
    }
    return {ready:false,source:null,issue:`The available Chromium executable could not be launched: ${String(error)}`};
  }
}
