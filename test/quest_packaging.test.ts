import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true, force:true}); });
function fixture(body='exit 0') {
  const dir=mkdtempSync(join(tmpdir(),'trek-apk-')); dirs.push(dir);
  const bin=join(dir,'bin'), project=join(dir,'project'); mkdirSync(bin); mkdirSync(project); symlinkSync(process.execPath,join(bin,'node'));
  writeFileSync(join(bin,'bubblewrap'),'#!/bin/bash\n'+body+'\n',{mode:0o755});
  const run=(args:string[]=[], extra:Record<string,string>={})=>spawnSync('/bin/bash',[resolve('scripts/package-quest-apk.sh'),...args],{
    env:{...process.env,PATH:bin+':/usr/bin:/bin',QUEST_ANDROID_DIR:project,...extra},encoding:'utf8'});
  return {dir,project,run};
}
describe('Quest package artifact checks (stub CLI, no Android build)',()=>{
  it('rejects missing hosted manifest configuration',()=>{
    const f=fixture(); const result=f.run(['--init'],{QUEST_MANIFEST_URL:''});
    expect(result.status).toBe(1); expect(result.stderr).toContain('HTTPS manifest');
  });
  it('passes the hosted manifest and Quest flag to initialization',()=>{
    const f=fixture('printf "%s\\n" "$@" > args.txt\nprintf "{}" > twa-manifest.json');
    expect(f.run(['--init'],{QUEST_MANIFEST_URL:'https://example.com/manifest.webmanifest'}).status).toBe(0);
    expect(readFileSync(join(f.project,'args.txt'),'utf8')).toBe('init\n--manifest=https://example.com/manifest.webmanifest\n--metaquest\n');
    expect(f.run(['--init'],{QUEST_MANIFEST_URL:'https://example.com/manifest.webmanifest'}).status).toBe(1);
  });
  it('rejects missing project and missing or stale build output',()=>{
    const f=fixture(); expect(f.run().status).toBe(1);
    writeFileSync(join(f.project,'twa-manifest.json'),'{}'); expect(f.run().status).toBe(1);
    const apk=join(f.project,'app-release-signed.apk');writeFileSync(apk,'old');utimesSync(apk,new Date(0),new Date(0));
    expect(f.run().status).toBe(1);
  });
  it('propagates build failure even when an old APK exists',()=>{
    const f=fixture('exit 9');writeFileSync(join(f.project,'twa-manifest.json'),'{}');
    writeFileSync(join(f.project,'app-release-signed.apk'),'old');expect(f.run().status).toBe(9);
  });
  it('reports a new nonempty output only after successful build',()=>{
    const f=fixture('printf "test APK placeholder" > app-release-signed.apk');
    writeFileSync(join(f.project,'twa-manifest.json'),'{}');
    const result=f.run(); expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('APK created:');
  });
});
