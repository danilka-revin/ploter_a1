import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';

const app = resolve(import.meta.dirname, '..');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: {
  ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
}, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}

async function waitHealth(url, predicate = () => true) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(url + '/healthz', { signal: AbortSignal.timeout(500) });
      const h = await r.json();
      if (r.ok && predicate(h)) return h;
    } catch { /* сервер ещё запускается */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Сервер не ответил после перезапуска');
}

for (const entry of ['start.mjs', 'server.mjs']) {
  test(`${entry}: настоящий сервер обновляется и перезапускается без /update/status`, { timeout: 25000, skip: process.platform === 'win32' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbd-restart-'));
    let child;
    let logs = '';
    try {
      const origin = join(root, 'origin.git');
      const work = join(root, 'work');
      mkdirSync(work);
      git(root, 'init', '--bare', '-b', 'main', origin);
      git(work, 'init', '-b', 'main');
      git(work, 'remote', 'add', 'origin', origin);
      const target = join(work, 'jbd-bms-app');
      mkdirSync(target);
      cpSync(join(app, 'scripts'), join(target, 'scripts'), { recursive: true });
      cpSync(join(app, '.gitignore'), join(target, '.gitignore'));
      cpSync(join(app, 'package.json'), join(target, 'package.json'));
      cpSync(join(app, 'package-lock.json'), join(target, 'package-lock.json'));
      git(work, 'add', '-A');
      git(work, 'commit', '-m', 'initial');
      git(work, 'push', '-u', 'origin', 'main');
      writeFileSync(join(work, '.git', 'info', 'exclude'), 'jbd-bms-app/node_modules\n');
      // Установка зависимостей/сборка подменены, git и HTTP-сервер настоящие.
      symlinkSync(join(app, 'node_modules'), join(target, 'node_modules'), 'dir');
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'npm'), 0o755);
      const port = await freePort();
      const url = `http://127.0.0.1:${port}`;
      const env = { ...process.env, BMS_APP_PORT: String(port), BMS_APP_HOST: '127.0.0.1',
        BMS_PRINTER_CONFIG: join(target, 'printer.json'), PATH: `${bin}:${process.env.PATH}` };
      delete env.BMS_APP_SUPERVISED;
      child = spawn(process.execPath, [join(target, 'scripts', entry)], { cwd: target, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (b) => { logs += b; });
      child.stderr.on('data', (b) => { logs += b; });
      const first = await waitHealth(url);
      const cfg = await fetch(url + '/api/printer/config', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/dev/ttyPRINTER', baudRate: 19200, profile: 'plain' }) });
      assert.equal(cfg.status, 200);
      const other = join(root, 'other');
      git(root, 'clone', origin, other);
      writeFileSync(join(other, 'jbd-bms-app', 'NEW.txt'), 'updated');
      git(other, 'add', '-A');
      git(other, 'commit', '-m', 'update');
      git(other, 'push', 'origin', 'main');
      const sha = git(other, 'rev-parse', '--short', 'HEAD');
      const run = await fetch(url + '/update/run', { method: 'POST' });
      assert.equal(run.status, 202);
      // Никакого опроса /update/status: уведомление updater само запускает restart.
      const second = await waitHealth(url, (h) => h.instanceId !== first.instanceId);
      assert.equal(second.commit, sha, logs);
      const state = await (await fetch(url + '/api/printer')).json();
      assert.equal(state.path, '/dev/ttyPRINTER');
      assert.equal(state.baudRate, 19200);
      assert.equal(readFileSync(join(target, 'NEW.txt'), 'utf8'), 'updated');
      assert.match(logs, /перезапуск после обновления/);
    } catch (e) { e.message += '\n' + logs; throw e; }
    finally {
      if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
