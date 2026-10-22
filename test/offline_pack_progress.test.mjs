import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { writePackProgress } from '../scripts/offline-pack-progress.mjs';

async function withFile(task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-progress-')), file = path.join(root, 'status.json');
  fs.writeFileSync(file, JSON.stringify({ state: 'previous' }));
  try { await task(file); }
  finally { for (const f of [file, file + '.partial']) if (fs.existsSync(f)) fs.unlinkSync(f); fs.rmdirSync(root); }
}
it.each(['EPERM', 'EACCES', 'EBUSY'])('preserves complete old JSON while %s blocks replacement, then retries the same new state', async code => {
  await withFile(async file => {
    let attempts = 0; const waits = [];
    const result = await writePackProgress(file, { state: 'acquiring', validated: 641 }, {
      rename: (from, to) => {
        if (++attempts < 3) { expect(JSON.parse(fs.readFileSync(file)).state).toBe('previous'); throw Object.assign(new Error('Sharing violation'), { code }); }
        fs.renameSync(from, to);
      }, sleep: async ms => { waits.push(ms); },
    });
    expect(result).toBe(true); expect(waits).toEqual([25, 50]);
    expect(JSON.parse(fs.readFileSync(file))).toEqual({ state: 'acquiring', validated: 641 });
    expect(fs.existsSync(file + '.partial')).toBe(false);
  });
});
it('bounds retries and returns an advisory failure without destroying the last complete status', async () => {
  await withFile(async file => {
    let attempts = 0; const waits = [], warnings = [];
    expect(await writePackProgress(file, { state: 'complete' }, {
      rename: () => { attempts++; throw Object.assign(new Error('Still held'), { code: 'EPERM' }); },
      sleep: async ms => { waits.push(ms); }, onWarning: event => warnings.push(event),
    })).toBe(false);
    expect(attempts).toBe(8); expect(waits.reduce((a, b) => a + b, 0)).toBe(1125);
    expect(warnings).toEqual([{ event: 'progress-write-deferred', file: 'status.json', code: 'EPERM' }]);
    expect(JSON.parse(fs.readFileSync(file)).state).toBe('previous');
  });
});
it('does not retry a nontransient status write error or abort its caller', async () => {
  const warnings = []; let attempts = 0;
  const saved = await writePackProgress('status.json', { state: 'failed' }, {
    write: () => { attempts++; throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); },
    rename: () => { throw Error('Must not rename'); }, onWarning: event => warnings.push(event),
  });
  expect(saved).toBe(false); expect(attempts).toBe(1); expect(warnings[0].code).toBe('ENOSPC');
});
