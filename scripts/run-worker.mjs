import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory } from '../dist/src/config.js';
import { recoverLock } from '../dist/src/storage/inbox-log.js';

export async function runWorker({directory = dataDirectory(), args = ['dist/src/index.js'], retryDelayMs = 15000} = {}) {
  let child, timer, stopping = false;
  const controller = new AbortController();
  const stop = () => {
    stopping = true;
    controller.abort();
    child?.kill('SIGTERM');
    timer = setTimeout(() => child?.kill('SIGKILL'), 40000);
    timer.unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    if (existsSync(join(directory, 'process.lock'))) recoverLock(directory);
    if (stopping) return 0;
    child = spawn(process.execPath, args, {stdio: 'inherit'});
    const code = await new Promise(resolve => {
      child.once('error', () => resolve(1));
      child.once('exit', (status, signal) => resolve(signal ? 1 : status ?? 1));
    });
    if (!stopping) {
      console.error('Inbox worker exited. Supervisor retry follows in 15 seconds.');
      await delay(retryDelayMs, undefined, {signal: controller.signal}).catch(() => {});
    }
    return stopping ? 0 : code;
  } catch {
    console.error('Inbox startup refused. Check configuration and verified lock ownership. Captured data remains intact.');
    if (!stopping) await delay(retryDelayMs, undefined, {signal: controller.signal}).catch(() => {});
    return 1;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runWorker();
}
