// Один supervisor для npm start, прямого node server.mjs и run-скриптов.
// Только код 10 перезапускает сервер; обычная ошибка не создаёт бесконечный цикл.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { RESTART_EXIT_CODE } from './updater.mjs';

export async function supervise(args = [], { serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url)) } = {}) {
  let child;
  let stopping = false;
  const stop = (signal) => { stopping = true; child?.kill(signal); };
  const sigint = () => stop('SIGINT');
  const sigterm = () => stop('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  try {
    while (!stopping) {
      const code = await new Promise((resolveExit) => {
        child = spawn(process.execPath, [...process.execArgv, serverPath, ...args], {
          env: { ...process.env, BMS_APP_SUPERVISED: '1' }, stdio: 'inherit',
        });
        child.once('error', (e) => { console.error(`Не удалось запустить сервер: ${e.message}`); resolveExit(1); });
        child.once('exit', (rc, signal) => resolveExit(rc ?? (signal === 'SIGINT' ? 130 : 143)));
      });
      if (stopping || code !== RESTART_EXIT_CODE) return code;
      console.log('--- перезапуск после обновления ---');
    }
    return 0;
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await supervise(process.argv.slice(2)));
}
