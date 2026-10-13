// Рендер экранов интерфейса на данных нужной формы (без браузера):
// проверяем, что экраны не падают и показывают важные тексты.
// Сборка через esbuild, который уже стоит вместе с Vite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'node_modules', '.cache');
const outFile = join(outDir, 'ui-render.mjs');

test('экраны рендерятся на данных плате и показывают ключевые сведения', async (t) => {
  if (!existsSync(join(root, 'node_modules', 'esbuild'))) { t.skip('esbuild не установлен'); return; }
  mkdirSync(outDir, { recursive: true });
  const entry = join(here, 'ui-render.entry.tsx');
  execFileSync(join(root, 'node_modules', '.bin', 'esbuild'), [
    entry, '--bundle', '--platform=node', '--format=esm', '--jsx=automatic',
    '--loader:.tsx=tsx', '--packages=external', `--outfile=${outFile}`, '--log-level=warning',
  ], { cwd: root, stdio: 'inherit' });
  const m = await import(pathToFileURL(outFile).href);

  const cellsText = m.renderCells();
  assert.match(cellsText, /Ячейка 1/);
  assert.match(cellsText, /3\.315 В/);
  assert.match(cellsText, /Разброс напряжений/);
  assert.match(cellsText, /15 мВ/);

  const overview = m.renderOverview();
  assert.match(overview, /13\.27/);
  assert.match(overview, /разряд/);
  assert.match(overview, /Защиты/);
  assert.match(overview, /защит нет/);
  assert.match(overview, /Балансируются ячейки: 3/);
  assert.match(overview, /Датчик 1/);

  const faulty = m.renderOverviewWithFault();
  assert.match(faulty, /Перенапряжение ячейки/);
  assert.match(faulty, /активно: 1/);

  const fw = m.renderFirmwareWithFile();
  assert.match(fw, /Запись отключена/);
  assert.match(fw, /Ошибки файла/);
  assert.match(fw, /неверная контрольная сумма/);

  const upd = m.renderUpdate();
  assert.match(upd, /Обновить с main/);
  assert.match(upd, /Сборка программы/);
  assert.match(upd, /Доступна новая версия/);

  const empty = m.renderOverviewDisconnected();
  assert.match(empty, /Плата не подключена/);
});
