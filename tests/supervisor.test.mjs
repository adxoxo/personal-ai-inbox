import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runWorker } from '../scripts/run-worker.mjs';

test('an active lock prevents another worker and preserves its lock bytes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-active-lock-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, 'process.lock');
  const lock = JSON.stringify({owner: 'test-owner', pid: process.pid, host: hostname()});
  writeFileSync(path, lock);
  const code = await runWorker({directory, args: ['-e', 'process.exit(99)'], retryDelayMs: 0});
  assert.equal(code, 1);
  assert.equal(readFileSync(path, 'utf8'), lock);
});

test('Overmind restarts a killed worker, retains one capture, and stops cleanly', {timeout: 20000}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'inbox-supervisor-'));
  const directory = join(root, 'data');
  mkdirSync(directory);
  const command = (...args) => execFileSync('overmind', args, {cwd: root, stdio: 'pipe', timeout: 5000,
    env: {...process.env, DOTENV_CONFIG_PATH: '/dev/null'}});
  t.after(() => {
    try {command('quit');} catch { /* Already stopped. */ }
    rmSync(root, {recursive: true, force: true});
  });
  const logModule = pathToFileURL(resolve('dist/src/storage/inbox-log.js')).href;
  const runner = pathToFileURL(resolve('scripts/run-worker.mjs')).href;
  const marker = join(root, 'workers.txt');
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, `import {InboxLog} from ${JSON.stringify(logModule)};
import {appendFileSync} from 'node:fs';
const log=new InboxLog(${JSON.stringify(directory)});
if(!log.get('1:10'))log.record({type:'capture',capture:{sourceId:'1:10',updateId:'100',chatId:'1',messageId:'10',userId:'1',capturedAt:'2026-10-20T00:00:00.000Z',timezone:'Etc/UTC',text:'Synthetic restart proof'}});
appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');
const timer=setInterval(()=>{},1000);
const stop=()=>{clearInterval(timer);log.close();};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
`);
  const wrapper = join(root, 'runner.mjs');
  writeFileSync(wrapper, `import {runWorker} from ${JSON.stringify(runner)};process.exitCode=await runWorker({directory:${JSON.stringify(directory)},args:[${JSON.stringify(worker)}],retryDelayMs:0});`);
  writeFileSync(join(root, 'Procfile'), `inbox: ${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)}\n`);
  command('start', '-D', '-N', '-t', '3', '-r', 'inbox', '-f', 'Procfile');
  async function waitFor(predicate) {
    const end = Date.now() + 8000;
    while (Date.now() < end) {if (predicate()) return; await delay(50);}
    throw new Error('Supervisor condition timed out');
  }
  const pids = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').map(Number) : [];
  await waitFor(() => pids().length === 1);
  const first = pids()[0];
  process.kill(first, 'SIGKILL');
  await waitFor(() => pids().length === 2);
  assert.notEqual(pids()[1], first);
  const events = readFileSync(join(directory, 'inbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(row => row.event.type === 'capture').length, 1);
  command('quit');
  await waitFor(() => !existsSync(join(directory, 'process.lock')));
});
