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
  assert.match(cellsText, /3\.315/);
  assert.match(cellsText, /Разброс:/);
  assert.match(cellsText, /15 мВ/);
  assert.match(cellsText, /баланс/);
  assert.equal((cellsText.match(/<tr/g) || []).length, 5, '4 ячейки + заголовок');

  const ctl = m.renderControl();
  assert.match(ctl, /Остаток ёмкости/);
  assert.match(ctl, /Сбросить счётчики/);
  assert.match(ctl, /Резервная копия настроек/);
  assert.match(ctl, /Не делается в приложении/);
  assert.doesNotMatch(ctl, /Выключить заряд/, 'ключи теперь на схеме, а не в управлении');

  // блок «Заряд и разряд»: схема и большие кнопки
  const pw = m.renderPower();
  assert.match(pw, /ЗАРЯД/);
  assert.match(pw, /РАЗРЯД/);
  assert.match(pw, /ВКЛЮЧЕН/);
  assert.match(pw, /Нажмите, чтобы ВЫКЛЮЧИТЬ/);
  assert.match(pw, /ключ заряда/);
  assert.match(pw, /ключ разряда/);
  assert.match(pw, /АККУМУЛЯТОР/);
  assert.match(pw, /13\.27 В/);
  assert.match(pw, /ПЛАТА BMS/);
  assert.equal((pw.match(/class="sc-cell/g) || []).length, 4, 'по одной полоске на ячейку');
  assert.match(pw, /aria-label="Схема:/);

  const pwOff = m.renderPowerDischargeOff();
  assert.match(pwOff, /РАЗРЯД/);
  assert.match(pwOff, /ВЫКЛЮЧЕН/);
  assert.match(pwOff, /Нажмите, чтобы ВКЛЮЧИТЬ/);
  assert.match(pwOff, /порт \/dev\/ttyUSB0/, 'схема показывает выбранный порт');

  const pwOffline = m.renderPowerDisconnected();
  assert.match(pwOffline, /подключите плату/);
  assert.match(pwOffline, /нет данных/);
  assert.match(pwOffline, /class="power-btn[^"]*" disabled=""/, 'кнопки выключены без платы');

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

  const set = m.renderSettingsIdle();
  assert.match(set, /Прочитать настройки/);
  assert.match(set, /Записать в плату/);
  assert.match(m.renderSettingsDisconnected(), /Плата не подключена/);
  const withData = m.renderSettingsWithData();
  assert.match(withData, /Перенапряжение ячейки \(OVP\)/);
  assert.match(withData, /Напряжение ячейки/);
  assert.match(withData, /3,650 В/);
  assert.match(withData, /40,0 А/);
  assert.match(withData, /только чтение/);
  assert.match(withData, /set-num/);
  assert.match(withData, /disabled=""[^>]*>Записать в плату/, 'кнопка записи выключена без изменений');

  const empty = m.renderOverviewDisconnected();
  assert.match(empty, /Плата не подключена/);

  // поиск батареи: карточка показывает найденную батарею и причины по остальным портам
  const scan = m.renderConnectionScan();
  assert.match(scan, /Найти батарею/);
  assert.match(scan, /Найдено батарей: 1/);
  assert.match(scan, /батарея отвечает: 12 ячеек, DEMO JBD 12S/);
  assert.match(scan, /порт занят или нет доступа/);
  assert.match(scan, />Подключить</);
  assert.match(scan, /Как понять, к какому порту подключена батарея/);

  const noAdapter = m.renderConnectionEmpty();
  assert.match(noAdapter, /Адаптер не найден/);
  assert.match(m.renderPortHelp(), /Найти батарею/);
  assert.match(m.renderPortHelp(), /dmesg/);

  // одна страница: ни одной вкладки, все блоки на месте
  const page = m.renderPage();
  assert.doesNotMatch(page, /role="tab"/);
  assert.match(page, /1\. Подключение к батарее/);
  assert.match(page, /2\. Заряд и разряд/);
  assert.match(page, /3\. Состояние батареи/);
  assert.match(page, /4\. Ячейки/);
  assert.match(page, /5\. Управление/);
  assert.match(page, /6\. Защиты и настройки платы/);
  assert.match(page, /7\. Прошивка/);

  // выбор порта: настоящий адаптер вытесняет демо, если пользователь сам его не выбирал
  assert.equal(m.pick('demo', ['/dev/ttyUSB0'], false), '/dev/ttyUSB0', 'демо не залипает');
  assert.equal(m.pick('demo', ['/dev/ttyUSB0'], true), 'demo', 'явный выбор демо сохраняется');
  assert.equal(m.pick('/dev/ttyUSB1', ['/dev/ttyUSB0', '/dev/ttyUSB1'], true), '/dev/ttyUSB1', 'выбранный порт остаётся');
  assert.equal(m.pick('/dev/ttyUSB1', ['/dev/ttyUSB0'], true), '/dev/ttyUSB0', 'пропавший порт заменяется первым');
  assert.equal(m.pick('/dev/ttyUSB0', [], false), 'demo', 'портов нет — демо');
});
