// Рендер плиток панели на данных нужной формы (SSR, без браузера): проверяем,
// что плитки не падают, делают акцент на банках в аккумуляторе, строят графики
// в едином дизайне и не показывают сырые регистры.
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

test('плитки панели рендерятся: акцент на банки в акуме, единый дизайн графиков, без регистров', async (t) => {
  if (!existsSync(join(root, 'node_modules', 'esbuild'))) { t.skip('esbuild не установлен'); return; }
  mkdirSync(outDir, { recursive: true });
  const entry = join(here, 'ui-render.entry.tsx');
  execFileSync(join(root, 'node_modules', '.bin', 'esbuild'), [
    entry, '--bundle', '--platform=node', '--format=esm', '--jsx=automatic',
    '--loader:.tsx=tsx', '--packages=external', `--outfile=${outFile}`, '--log-level=warning',
  ], { cwd: root, stdio: 'inherit' });
  const m = await import(pathToFileURL(outFile).href);

  // главный блок «Банки в аккумуляторе»: сводка и карточка каждой банки #1…#12
  const cells = m.renderCells();
  assert.match(cells, /12S/);
  assert.match(cells, /12 банок/);
  assert.match(cells, /Разброс банок Δ/);
  assert.match(cells, /3,297/);
  assert.match(cells, /3,318/);
  assert.equal((cells.match(/class="cell-card/g) || []).length, 12, 'по одной карточке на каждую банку в акуме');
  assert.match(cells, /Банка #1/);
  assert.match(cells, /Банка #12/);
  assert.match(cells, /БАЛ/, 'балансируемая банка помечена');
  assert.match(cells, /МИН/, 'минимальная банка помечена');
  assert.match(cells, /МАКС/, 'максимальная банка помечена');
  assert.match(cells, /is-pick/, 'выбранная банка подсвечена');
  assert.match(m.renderCellsEmpty(), /Нет данных по банкам в аккумуляторе/);

  // отчёт по всем банкам: онлайн и офлайн строки, числа, мини-график
  const report = m.renderBanks();
  assert.match(report, /BANK A/);
  assert.match(report, /BANK B/);
  assert.match(report, /39,71/);
  assert.match(report, /-29,90/);
  assert.match(report, /нет связи/);
  assert.match(report, /is-focus/, 'выбранный банк подсвечен');
  assert.match(report, /is-off/, 'банк без связи помечен');
  assert.match(report, /Перенапряжение ячейки/, 'активная защита видна в отчёте');
  assert.match(report, /class="spark/, 'в строке есть мини-график');
  assert.equal((report.match(/<tr/g) || []).length, 3, '2 банка + заголовок');

  assert.match(m.renderBanksEmpty(), /Банков пока нет/);
  assert.match(m.renderBanksEmpty(), /Найти и подключить все/);

  // ключевые числа: банк и парк
  const kpi = m.renderKpis();
  assert.match(kpi, /Напряжение/);
  assert.match(kpi, /39,71/);
  assert.match(kpi, /Разброс ячеек/);
  assert.match(kpi, /Мин · макс банок/);
  assert.match(kpi, /21/);
  assert.match(kpi, /gauge/, 'есть шкала остатка заряда');
  assert.match(m.renderKpisFleet(), /весь парк|Активных защит/);

  // графики: все 6 в едином дизайне (chart-head, ch-legend, линии с заливкой ch-area)
  const charts = m.renderCharts();
  assert.match(charts, /Банки в акуме · напряжение/);
  assert.match(charts, /Разброс ячеек · остаток заряда/);
  assert.match(charts, /Профиль банок/);
  assert.match(charts, /Напряжение · ток/);
  assert.match(charts, /Мощность/);
  assert.match(charts, /Температуры/);
  assert.equal((charts.match(/class="chart-box"/g) || []).length, 6, 'все 6 блоков — единые карточки графиков');
  assert.equal((charts.match(/class="chart-head"/g) || []).length, 6, 'у каждого графика единая шапка с показанием');
  assert.equal((charts.match(/class="ch-legend"/g) || []).length, 6, 'у каждого графика единая легенда снизу');
  assert.match(charts, /<path/, 'графики построены линиями');
  assert.match(charts, /class="ch-area"/, 'единая мягкая заливка под линиями');
  assert.equal((charts.match(/class="cb-col/g) || []).length, 12, 'по одной полоске на банку в профиле');
  assert.match(charts, /cb-col is-bal/, 'балансируемая банка подсвечена');
  assert.doesNotMatch(charts, /Хронология опросов/, 'текстовый список убран из сетки графиков');
  assert.match(m.renderChartsNoData(), /Графики появятся через минуту/);

  // вкладка данных: акцент на банки, никаких сырых номеров регистров
  const data = m.renderDataBody();
  assert.match(data, /Банки в аккумуляторе/);
  assert.match(data, /Напряжение сборки/);
  assert.match(data, /39,71 В/);
  assert.match(data, /Ключ заряда/);
  assert.match(data, /включён/);
  assert.match(data, /Короткое замыкание/);
  assert.match(data, /SW 4\.21-LFP/);
  assert.match(data, /17\.05\.2024/);
  assert.match(data, /Счётчики срабатываний/);
  assert.doesNotMatch(data, /регистр 0x|0xAA|0x05…0x0A|Сырое слово защит/, 'сырые регистры убраны из данных платы');

  // вкладка записи: параметры без колонки регистров и без байтовых меток
  const set = m.renderSettingsBody();
  assert.match(set, /Перенапряжение ячейки \(OVP\)/);
  assert.match(set, /3650/);
  assert.match(set, /Таблица SOC/);
  assert.match(set, />риск</, 'рискованные параметры помечены');
  assert.match(set, /Балансировка разрешена/, 'маска показана чипами');
  assert.match(set, /disabled=""[^>]*>Записать/, 'без изменений кнопка записи выключена');
  assert.doesNotMatch(set, /value="3600"/, 'поле показывает значение платы, а не выдумку');
  assert.doesNotMatch(set, /0x24|0x44|старший байт|младший байт|консоли регистров/, 'сырые адреса регистров и байты убраны');

  const tile = m.renderDataTile();
  assert.match(tile, /Все данные платы/);
  assert.match(tile, /Защита и настройки/);
  assert.match(tile, /Прошивка/);
  assert.match(m.renderDataEmpty(), /Банк не выбран|Читаю данные/);

  // управление
  const ops = m.renderControl();
  assert.match(ops, /заряд включён/);
  assert.match(ops, /разряд выключен/);
  assert.match(ops, /Балансировка/);
  assert.match(ops, /Сбросить счётчики защит/);
  assert.match(ops, /остаток ёмкости, Ач/);
  assert.match(ops, /Копия настроек/);
  assert.match(ops, /Пересчитать SOC/);
  assert.match(ops, /всем банкам/, 'есть режим «команда всем банкам»');
  assert.match(m.renderControlDisconnected(), /банк не выбран|цель: BANK B/);

  // подключение и журнал
  const connect = m.renderConnect();
  assert.match(connect, /\/dev\/ttyUSB0/);
  assert.match(connect, /занят банком/);
  assert.match(connect, /Найти и подключить все/);
  assert.match(connect, /Демо-банки/);
  assert.match(connect, /в отчёте 2 банка/);
  assert.doesNotMatch(connect, /доступных регистров/, 'каталог сырых регистров не показывается');
  const jr = m.renderJournal();
  assert.match(jr, /Записано 2 пар\./);
  assert.match(jr, /связь потеряна/);

  // прошивка и обновления
  const fw = m.renderFirmware();
  assert.match(fw, /Запись отключена/);
  assert.match(fw, /Ошибки файла/);
  assert.match(fw, /неверная контрольная сумма/);
  const upd = m.renderUpdate();
  assert.match(upd, /Сборка программы/);
  assert.match(upd, /Доступна новая версия/);

  // вся панель: главный блок «Банки в аккумуляторе», единые графики, консоль регистров убрана
  const app = m.renderApp();
  assert.doesNotMatch(app, /role="tab"/, 'никаких вкладок-страниц');
  assert.match(app, /Банки в аккумуляторе/);
  assert.match(app, /Отчёт по всем банкам/);
  assert.match(app, /Графики/);
  assert.match(app, /Плата: все данные и настройки/);
  assert.match(app, /Управление/);
  assert.doesNotMatch(app, /Консоль регистров|data-area="con"/, 'консоль регистров убрана');
  assert.match(app, /data-area="cel"/, 'плитка банок в аккумуляторе на месте');
  assert.match(app, /data-density|data-area="bar"/);
  assert.match(app, /CSV отчёт/);
});
