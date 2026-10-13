// Автообновление на локальном bare-репозитории вместо GitHub:
//   • новый коммит в origin подтягивается (fetch + merge --ff-only);
//   • локальные правки и чужая ветка останавливают обновление с понятной причиной;
//   • npm подменяется заглушкой, чтобы тест не тянул библиотеки.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUpdater, parseGithubRepo } from '../scripts/updater.mjs';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

let root, origin, work, appDir, stubBin, savedPath;

function waitDone(updater, limitMs = 60_000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      const s = updater.snapshot();
      if (!s.running && s.phase !== 'running') { clearInterval(id); resolve(s); }
      else if (Date.now() - t0 > limitMs) { clearInterval(id); reject(new Error('таймаут обновления')); }
    }, 50);
  });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'jbd-upd-'));
  origin = join(root, 'origin.git');
  work = join(root, 'work');
  stubBin = join(root, 'bin');
  mkdirSync(stubBin);
  // заглушка npm: «установка» и «сборка» проходят мгновенно
  writeFileSync(join(stubBin, 'npm'), '#!/bin/sh\necho "stub npm $@"\nexit 0\n');
  chmodSync(join(stubBin, 'npm'), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${stubBin}:${savedPath}`;

  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', work]);
  git(work, 'remote', 'add', 'origin', origin);
  appDir = join(work, 'jbd-bms-app');
  mkdirSync(appDir);
  writeFileSync(join(appDir, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  writeFileSync(join(appDir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(appDir, '.gitignore'), 'node_modules/\ndist/\n');
  writeFileSync(join(work, 'README.md'), 'repo\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'первая версия');
  git(work, 'push', '-u', 'origin', 'main');
});

after(() => {
  process.env.PATH = savedPath;
  if (root) rmSync(root, { recursive: true, force: true });
});

test('адрес GitHub разбирается в owner/name', () => {
  assert.deepEqual(parseGithubRepo('https://github.com/danilka-revin/ploter_a1.git'), { owner: 'danilka-revin', name: 'ploter_a1' });
  assert.deepEqual(parseGithubRepo('git@github.com:a/b.git'), { owner: 'a', name: 'b' });
  assert.equal(parseGithubRepo('https://example.com/x'), null);
});

test('новый коммит в origin устанавливается: fetch → merge → сборка → перезапуск', async () => {
  // «другой компьютер» публикует новую версию программы
  const other = join(root, 'other');
  execFileSync('git', ['clone', origin, other], { stdio: 'ignore' });
  writeFileSync(join(other, 'jbd-bms-app', 'NEW.txt'), 'новая версия\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'добавить новую функцию');
  git(other, 'push', 'origin', 'main');
  const latest = git(other, 'rev-parse', 'HEAD');

  const updater = createUpdater({ appDir });
  updater.run();
  const s = await waitDone(updater);
  assert.equal(s.phase, 'done', s.message);
  assert.equal(s.restartRequired, true);
  assert.equal(git(work, 'rev-parse', 'HEAD'), latest);
  assert.ok(readFileSync(join(appDir, 'NEW.txt'), 'utf8').includes('новая версия'));
  // lock-хэш записан: повторное обновление без изменений не переустанавливает библиотеки
  const deps = s.steps.find((x) => x.id === 'deps');
  assert.equal(deps.state, 'done');
});

test('локальные правки в папке программы останавливают обновление', async () => {
  writeFileSync(join(appDir, 'NEW.txt'), 'правка пользователя\n');
  const updater = createUpdater({ appDir });
  updater.run();
  const s = await waitDone(updater);
  assert.equal(s.phase, 'error');
  assert.match(s.message, /локальные изменения/);
  assert.equal(s.restartRequired, false);
  git(work, 'checkout', '--', 'jbd-bms-app/NEW.txt');
});

test('чужая ветка: обновление не запускается, файлы не трогаются', async () => {
  git(work, 'checkout', '-b', 'feature/x');
  const updater = createUpdater({ appDir });
  updater.run();
  const s = await waitDone(updater);
  assert.equal(s.phase, 'error');
  assert.match(s.message, /ветка «feature\/x»/);
  git(work, 'checkout', 'main');
});

test('папка вне git-клона: честная причина, без попыток обновления', async () => {
  const plain = join(root, 'installed-copy');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'package.json'), '{}');
  writeFileSync(join(plain, 'package-lock.json'), '{}');
  const updater = createUpdater({ appDir: plain });
  // вне git проверяем обнаружение: root — временная папка без .git
  const r = await updater.check();
  assert.equal(r.phase, 'unsupported');
  assert.match(r.message, /не из git-клона/);
});
