import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const npm=process.platform==='win32'?'npm.cmd':'npm';
const command=process.platform==='win32'?'cmd.exe':npm;
const args=process.platform==='win32'?['/d','/s','/c','npm pack --dry-run --json --ignore-scripts']:['pack','--dry-run','--json','--ignore-scripts'];
const output=execFileSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024});
const reports=JSON.parse(output);
if(!Array.isArray(reports)||!Array.isArray(reports[0]?.files))throw new Error('Unable to inspect npm package contents.');
const files=reports[0].files.map(entry=>entry.path);
const bad=[];
const requiredFiles=['INSTALL.md','README.md','README.id.md','SETUP.md','SETUP.id.md','instructions/neutral.md','prompts/bootstrap.en.md','prompts/bootstrap.id.md','prompts/setup.en.md','prompts/setup.id.md','skills/jose/SKILL.md'];
for(const file of requiredFiles)if(!files.includes(file))bad.push(`${file}: required installer asset missing`);
const forbiddenPath=/(^|\/)(\.git|\.env(?:\.|$)|\.dev\.vars|node_modules|\.jose|browser|state|sources|applications|client-config|\.jose-runtime)(\/|$)|\.(?:sqlite(?:-wal|-shm)?|pem|key)$/i;
const secretPatterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\b(?:sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/];
for(const file of files) {
  if(forbiddenPath.test(file))bad.push(`${file}: private or runtime path`);
  const absolute=resolve(root,file);
  if(!absolute.startsWith(root+sep))throw new Error('Package path escaped repository.');
  const bytes=readFileSync(absolute);
  if(bytes.length<2_000_000&&!bytes.includes(0)) {
    const text=bytes.toString('utf8');
    if(secretPatterns.some(pattern=>pattern.test(text)))bad.push(`${file}: possible credential`);
  }
}
if(bad.length){console.error(JSON.stringify({ok:false,issues:bad},null,2));process.exitCode=1;}
else console.log(JSON.stringify({ok:true,files:files.length,note:'Package paths and common private-key patterns checked; review content and history separately.'},null,2));
