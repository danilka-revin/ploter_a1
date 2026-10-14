// Автообновление из GitHub — та же схема, что в PSBees (linux_pcb_app):
//   1. раз в полчаса спрашиваем GitHub, есть ли в ветке новый коммит с этой программой;
//   2. если есть — кнопка «Обновить с main» подсвечивается;
//   3. по нажатию: git fetch → merge --ff-only → npm ci (если изменился package-lock)
//      → сборка → сервер перезапускается (код выхода 10, его поднимает run.sh).
//
// Обновление делаем только в чистом git-клоне, на нужной ветке и без локальных
// правок в папке программы. В остальных случаях честно сообщаем причину и не
// трогаем файлы. Настройки (необязательно) — update.json рядом с package.json:
//   { "repo": "https://github.com/danilka-revin/ploter_a1.git", "branch": "main" }

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const RESTART_EXIT_CODE = 10;
const CHECK_INTERVAL_MS = 30 * 60_000;
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export const UPDATE_STEPS = [
  { id: 'check', title: 'Проверка папки и ветки' },
  { id: 'fetch', title: 'Загрузка изменений с GitHub' },
  { id: 'merge', title: 'Установка новой версии' },
  { id: 'deps', title: 'Библиотеки (npm ci)' },
  { id: 'build', title: 'Сборка программы' },
  { id: 'restart', title: 'Перезапуск программы' },
];

/** Запуск внешней команды с таймаутом; возвращает код и хвост вывода. */
export function run(cmd, args, { cwd, timeoutMs = 120_000, env = {} } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        // Windows не запускает npm.cmd через CreateProcess без cmd.exe.
        shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd),
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: -1, out: String(e.message || e) });
      return;
    }
    const timer = setTimeout(() => { out += '\nпревышено время ожидания'; child.kill('SIGTERM'); }, timeoutMs);
    const feed = (b) => { out = (out + b.toString()).slice(-4000); };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out: out.trim() }); });
  });
}

/** owner/name из URL репозитория GitHub. */
export function parseGithubRepo(url) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(String(url || ''));
  return m ? { owner: m[1], name: m[2] } : null;
}

export function createUpdater({ appDir, log = () => {}, onReady = () => {} }) {
  const cfg = readConfig(appDir);
  const repo = parseGithubRepo(cfg.repo);

  const state = {
    phase: 'idle',           // idle | checking | ready | running | done | error | unsupported
    message: '',
    currentSha: '',
    latestSha: '',
    latestDate: '',
    latestMessage: '',
    updateAvailable: false,
    branch: cfg.branch,
    repo: cfg.repo,
    checkedAt: 0,
    steps: UPDATE_STEPS.map((s) => ({ ...s, state: 'wait', detail: '' })),
    restartRequired: false,
    reason: '',
  };

  let gitRoot = null;      // корень git-репозитория или null
  let appRel = '';         // путь папки программы внутри репозитория
  let running = false;

  async function detect() {
    if (gitRoot !== null) return;
    const r = await run('git', ['rev-parse', '--show-toplevel'], { cwd: appDir, timeoutMs: 10_000 });
    if (r.code !== 0) { gitRoot = ''; return; }
    gitRoot = r.out.trim();
    const rel = relative(gitRoot, appDir).split(sep).join('/');
    appRel = rel === '' ? '' : rel;
  }

  async function localCommit() {
    const args = ['log', '-1', '--format=%H%n%cI', '--'];
    if (appRel) args.push(appRel);
    const r = await run('git', args, { cwd: gitRoot, timeoutMs: 15_000 });
    const [sha = '', date = ''] = r.out.split('\n');
    return { sha: r.code === 0 ? sha.trim() : '', date: r.code === 0 ? date.trim() : '' };
  }

  async function dirty() {
    const args = ['status', '--porcelain'];
    if (appRel) args.push('--', appRel);
    const r = await run('git', args, { cwd: gitRoot, timeoutMs: 15_000 });
    return r.out.trim() !== '';
  }

  /** Последний коммит ветки, затрагивающий папку программы (GitHub API). */
  async function remoteCommit() {
    if (!repo) throw new Error(`не разобран адрес репозитория: ${cfg.repo}`);
    const qs = new URLSearchParams({ sha: cfg.branch, per_page: '1' });
    if (appRel) qs.set('path', appRel);
    const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/commits?${qs}`;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'jbd-bms-app-updater' },
    });
    if (r.status === 404) throw new Error(`ветка «${cfg.branch}» не найдена в ${cfg.repo}`);
    if (!r.ok) throw new Error(`GitHub ответил HTTP ${r.status}`);
    const list = await r.json();
    const c = Array.isArray(list) ? list[0] : null;
    if (!c) return null;
    return {
      sha: c.sha,
      date: c.commit?.committer?.date || '',
      message: (c.commit?.message || '').split('\n')[0],
    };
  }

  /** Проверка новой версии. Не меняет файлы. */
  async function check() {
    if (running || state.restartRequired) return snapshot();
    state.phase = 'checking';
    try {
      await detect();
      if (running || state.restartRequired) return snapshot();
      if (!gitRoot) {
        setUnsupported('Программа установлена не из git-клона, поэтому автообновление недоступно. '
          + 'Переустановите её через install-windows.cmd или install-ubuntu.sh (см. README).');
        return snapshot();
      }
      const local = await localCommit();
      state.currentSha = local.sha;
      const remote = await remoteCommit();
      if (running || state.restartRequired) return snapshot();
      state.checkedAt = Date.now();
      if (!remote) {
        state.phase = 'idle';
        state.updateAvailable = false;
        state.latestSha = '';
        state.message = `В ветке «${cfg.branch}» на GitHub ещё нет этой программы.`;
        return snapshot();
      }
      state.latestSha = remote.sha;
      state.latestDate = remote.date;
      state.latestMessage = remote.message;
      const newer = !local.date || Date.parse(remote.date) > Date.parse(local.date);
      state.updateAvailable = Boolean(remote.sha && remote.sha !== local.sha && newer);
      state.phase = state.updateAvailable ? 'ready' : 'idle';
      state.message = state.updateAvailable
        ? `Доступна новая версия (${remote.sha.slice(0, 7)}).`
        : 'Установлена актуальная версия.';
    } catch (e) {
      if (running || state.restartRequired) return snapshot();
      state.phase = 'error';
      state.message = `Нет связи с GitHub: ${e.message || e}. Продолжаем работать на текущей версии.`;
    }
    return snapshot();
  }

  function setUnsupported(text) {
    state.phase = 'unsupported';
    state.message = text;
    state.reason = text;
    state.updateAvailable = false;
  }

  /** Установка обновления. Возвращает сразу; ход — в snapshot().steps. */
  function run_() {
    if (running || state.restartRequired) return snapshot();
    running = true;
    state.phase = 'running';
    state.restartRequired = false;
    state.message = 'Обновление запущено…';
    for (const s of state.steps) { s.state = 'wait'; s.detail = ''; }
    doUpdate().finally(() => { running = false; });
    return snapshot();
  }

  function step(id, st, detail = '') {
    const s = state.steps.find((x) => x.id === id);
    if (s) { s.state = st; s.detail = detail; }
  }

  async function fail(id, text) {
    step(id, 'error', text);
    state.phase = 'error';
    state.message = text;
    log(`обновление не выполнено: ${text}`);
  }

  async function doUpdate() {
    try {
      step('check', 'run');
      await detect();
      if (!gitRoot) return void fail('check', 'Программа не из git-клона — автообновление недоступно.');
      if (await dirty()) {
        return void fail('check', 'В папке программы есть локальные изменения. Сохраните или откатите их и повторите.');
      }
      const br = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: gitRoot });
      const current = br.out.trim();
      if (current !== cfg.branch) {
        return void fail('check', `Сейчас выбрана ветка «${current}», а обновляем ветку «${cfg.branch}». `
          + 'Переключитесь на неё или обновитесь вручную.');
      }
      step('check', 'done');

      step('fetch', 'run');
      const fetched = await run('git', ['fetch', 'origin', cfg.branch], { cwd: gitRoot, timeoutMs: 120_000 });
      if (fetched.code !== 0) return void fail('fetch', `Не удалось загрузить изменения: ${fetched.out.split('\n').pop()}`);
      step('fetch', 'done');

      step('merge', 'run');
      const before = (await run('git', ['rev-parse', 'HEAD'], { cwd: gitRoot })).out.trim();
      const target = (await run('git', ['rev-parse', `origin/${cfg.branch}`], { cwd: gitRoot })).out.trim();
      if (before !== target) {
        const merged = await run('git', ['merge', '--ff-only', `origin/${cfg.branch}`], { cwd: gitRoot, timeoutMs: 60_000 });
        if (merged.code !== 0) {
          return void fail('merge', 'Нельзя применить обновление без слияния: в ветке есть свои коммиты. Обновитесь вручную: git pull.');
        }
        step('merge', 'done', target.slice(0, 7));
      } else {
        step('merge', 'skip', 'уже последняя версия');
      }

      step('deps', 'run');
      const lockHash = createHash('sha256').update(readFileSync(join(appDir, 'package-lock.json'))).digest('hex');
      const hashFile = join(appDir, 'node_modules', '.lock.sha256');
      const depsOk = existsSync(join(appDir, 'node_modules')) && readText(hashFile) === lockHash;
      if (!depsOk) {
        const ci = await run(NPM_COMMAND, ['ci', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'],
          { cwd: appDir, timeoutMs: 15 * 60_000 });
        if (ci.code !== 0) return void fail('deps', `npm ci: ${ci.out.split('\n').slice(-3).join(' ')}`);
        mkdirSync(join(appDir, 'node_modules'), { recursive: true });
        writeFileSync(hashFile, lockHash);
        step('deps', 'done');
      } else {
        step('deps', 'skip', 'не менялись');
      }

      step('build', 'run');
      const build = await run(NPM_COMMAND, ['run', 'build', '--no-update-notifier'], { cwd: appDir, timeoutMs: 10 * 60_000 });
      if (build.code !== 0) {
        return void fail('build', 'Сборка не прошла — программа продолжит работать на прежней версии. '
          + build.out.split('\n').slice(-3).join(' '));
      }
      step('build', 'done');

      step('restart', 'done', 'сервер перезапустится');
      state.phase = 'done';
      state.restartRequired = true;
      state.message = 'Обновление установлено. Программа перезапускается…';
      state.updateAvailable = false;
      onReady(snapshot());
    } catch (e) {
      await fail(state.steps.find((s) => s.state === 'run')?.id || 'check', String(e.message || e));
    }
  }

  function snapshot() {
    return {
      ...state,
      steps: state.steps.map((s) => ({ ...s })),
      running,
      nextCheckMs: CHECK_INTERVAL_MS,
    };
  }

  return {
    check,
    run: run_,
    snapshot,
    CHECK_INTERVAL_MS,
  };
}

function readText(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

function readConfig(appDir) {
  const defaults = { repo: 'https://github.com/danilka-revin/ploter_a1.git', branch: 'main' };
  try {
    const j = JSON.parse(readFileSync(join(appDir, 'update.json'), 'utf8'));
    return { ...defaults, ...j };
  } catch {
    return defaults;
  }
}
