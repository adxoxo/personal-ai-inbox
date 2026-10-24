import { execFileSync } from 'node:child_process';
import { lstatSync, renameSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

function probe(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve('alive'); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('supervisor_socket_timeout')); });
    socket.once('error', error => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(error.code);
      else reject(new Error('supervisor_socket_unverifiable'));
    });
  });
}

export async function ensureSupervisor(directory) {
  const run = args => {
    try {return execFileSync('overmind', args, {cwd: directory, stdio: 'pipe', timeout: 10000});}
    catch (error) {error.startupStep = args[0]; throw error;}
  };
  try {
    run(['status']);
    return 'already-running';
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('overmind_missing');
  }
  const path = join(directory, '.overmind.sock');
  let before;
  try {
    before = lstatSync(path);
    if (!before.isSocket()) throw new Error('supervisor_path_is_not_socket');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const state = await probe(path);
  if (state === 'alive') throw new Error('supervisor_socket_active_but_status_failed');
  if (state === 'ECONNREFUSED') {
    const current = lstatSync(path);
    if (!before || current.ino !== before.ino || current.dev !== before.dev) {
      throw new Error('supervisor_socket_changed');
    }
    renameSync(path, `${path}.stale-${Date.now()}-${process.pid}`);
  }
  run(['start', '-D', '-N', '-t', '45', '-r', 'inbox', '-f', 'Procfile']);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {run(['status']); return 'started';}
    catch {await delay(100);}
  }
  throw new Error('supervisor_status_timeout');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)));
  try {
    console.log(`Inbox supervisor: ${await ensureSupervisor(directory)}`);
  } catch (error) {
    const reason = error.startupStep ? `overmind_${error.startupStep}_failed`
      : /^(supervisor_[a-z_]+|overmind_missing)$/.test(error.message) ? error.message : 'startup_failed';
    console.error(`Inbox supervisor startup refused (${reason}). Check the private runtime and socket ownership.`);
    process.exitCode = 1;
  }
}
