import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Status is an observer, never the publication record. Windows readers and
 * scanners can briefly deny rename/delete sharing; keep the last complete JSON
 * and retry without turning a status-write failure into source-acquisition loss. */
export async function writePackProgress(file, value, options = {}) {
  const write = options.write ?? fs.writeFileSync, rename = options.rename ?? fs.renameSync;
  const sleep = options.sleep ?? delay, json = JSON.stringify(value, null, 2) + '\n';
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      write(file + '.partial', json); rename(file + '.partial', file); return true;
    } catch (error) {
      if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code) && attempt < 7) {
        const delayMs = Math.min(250, 25 * 2 ** attempt);
        options.onRetry?.({ attempt: attempt + 1, code: error.code, delayMs });
        await sleep(delayMs); continue;
      }
      const warning = { event: 'progress-write-deferred', file: path.basename(file), code: error.code ?? error.name };
      (options.onWarning ?? (value => console.error(JSON.stringify(value))))(warning);
      return false;
    }
  }
}
