import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureSupervisor } from '../scripts/ensure-supervisor.mjs';

const exec = promisify(execFile);
async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fixture_timeout');
    await delay(50);
  }
}

test('boot recovery preserves captures and concurrent starts create only one worker', {timeout: 30000}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'inbox-boot-'));
  const directory = join(root, 'data');
  mkdirSync(directory);
  const env = {...process.env, DOTENV_CONFIG_PATH: '/dev/null'};
  const command = (...args) => execFileSync('overmind', args, {cwd: root, env, stdio: 'pipe', timeout: 5000});
  let old;
  t.after(() => {
    old?.kill('SIGKILL');
    try {command('quit');} catch { /* Fixture already stopped. */ }
    rmSync(root, {recursive: true, force: true});
  });
  const logModule = pathToFileURL(resolve('dist/src/storage/inbox-log.js')).href;
  const runner = pathToFileURL(resolve('scripts/run-worker.mjs')).href;
  const marker = join(root, 'workers.txt');
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, `import {InboxLog} from ${JSON.stringify(logModule)};
import {appendFileSync} from 'node:fs';
import {createServer} from 'node:net';
const log=new InboxLog(${JSON.stringify(directory)});
if(!log.get('1:10'))log.record({type:'capture',capture:{sourceId:'1:10',updateId:'100',chatId:'1',messageId:'10',userId:'1',capturedAt:'2026-10-24T00:00:00.000Z',timezone:'Etc/UTC',text:'Synthetic boot capture'}});
appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');
const timer=setInterval(()=>{},1000);
let server;
if(process.argv[2]==='stale')server=createServer().listen(${JSON.stringify(join(root, '.overmind.sock'))});
const stop=()=>{clearInterval(timer);server?.close();log.close();};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
`);
  const wrapper = join(root, 'runner.mjs');
  writeFileSync(wrapper, `import {runWorker} from ${JSON.stringify(runner)};process.exitCode=await runWorker({directory:${JSON.stringify(directory)},args:[${JSON.stringify(worker)}],retryDelayMs:0});`);
  writeFileSync(join(root, 'Procfile'), `inbox: ${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)}\n`);
  old = spawn(process.execPath, [worker, 'stale'], {cwd: root, env, stdio: 'pipe'});
  await waitFor(() => existsSync(join(root, '.overmind.sock')) && existsSync(marker));
  const journal = join(directory, 'inbox.jsonl');
  const original = readFileSync(journal);
  const stopped = once(old, 'exit'); old.kill('SIGKILL'); await stopped;
  const starter = resolve('scripts/ensure-supervisor.mjs');
  const args = ['-w', '20', join(root, '.supervisor-start.lock'), process.execPath, starter, root];
  const starts = await Promise.all([exec('flock', args, {env}), exec('flock', args, {env})]);
  assert(starts.some(result => result.stdout.includes('started')));
  assert(starts.some(result => result.stdout.includes('already-running')));
  await waitFor(() => readFileSync(marker, 'utf8').trim().split('\n').length === 2);
  assert.deepEqual(readFileSync(journal), original);
  assert.equal(readdirSync(root).filter(name => name.startsWith('.overmind.sock.stale-')).length, 1);
  assert.equal(await ensureSupervisor(root), 'already-running');
  assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 2);
  command('quit');
  await waitFor(() => !existsSync(join(directory, 'process.lock')));
});

function failingStatus(t) {
  const root = mkdtempSync(join(tmpdir(), 'inbox-boot-refusal-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'overmind'), '#!/bin/sh\nexit 1\n', {mode: 0o700});
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(() => {process.env.PATH = previous; rmSync(root, {recursive: true, force: true});});
  return root;
}

test('a live socket with failed status is preserved', async t => {
  const root = failingStatus(t);
  const path = join(root, '.overmind.sock');
  const server = createServer(socket => socket.destroy());
  server.listen(path); await once(server, 'listening');
  try {
    await assert.rejects(ensureSupervisor(root), /socket_active_but_status_failed/);
    assert(existsSync(path));
  } finally {await new Promise(resolve => server.close(resolve));}
});

test('a regular file at the socket path is never moved or overwritten', async t => {
  const root = failingStatus(t);
  const path = join(root, '.overmind.sock');
  writeFileSync(path, 'preserve');
  await assert.rejects(ensureSupervisor(root), /path_is_not_socket/);
  assert.equal(readFileSync(path, 'utf8'), 'preserve');
});
