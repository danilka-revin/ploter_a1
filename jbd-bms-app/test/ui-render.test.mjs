// Рендер плиток панели на данных нужной формы (SSR, без браузера): проверяем,
// что плитки не падают и показывают главные числа, графики и точки записи.
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

test('плитки панели рендерятся и показывают ключевые сведения', async (t) => {
  if (!existsSync(join(root, 'node_modules', 'esbuild'))) { t.skip('esbuild не установлен'); return; }
  mkdirSync(outDir, { recursive: true });
  const entry = join(here, 'ui-render.entry.tsx');
  execFileSync(join(root, 'node_modules', '.bin', 'esbuild'), [
    entry, '--bundle', '--platform=node', '--format=esm', '--jsx=automatic',
    '--loader:.tsx=tsx', '--packages=external', `--outfile=${outFile}`, '--log-level=warning',
  ], { cwd: root, stdio: 'inherit' });
  const m = await import(pathToFileURL(outFile).href);

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
  assert.match(kpi, /21/);
  assert.match(kpi, /gauge/, 'есть шкала остатка заряда');
  assert.match(m.renderKpisFleet(), /весь парк|Активных защит/);

  // графики: линии, пороги, полоски ячеек
  const charts = m.renderCharts();
  assert.match(charts, /Напряжение · ток/);
  assert.match(charts, /Мощность/);
  assert.match(charts, /Температуры/);
  assert.match(charts, /Разброс ячеек · остаток заряда/);
  assert.match(charts, /<path/, 'график построен линиями');
  assert.equal((charts.match(/class="cb-col/g) || []).length, 12, 'по одной полоске на ячейку');
  assert.match(charts, /cb-col is-bal/, 'балансируемая ячейка подсвечена');
  assert.match(charts, /Хронология опросов/);
  assert.match(m.renderChartsNoData(), /Графики появятся через минуту/);

  // вкладка данных: всё, что читается с платы
  const data = m.renderDataBody();
  assert.match(data, /Напряжение сборки/);
  assert.match(data, /39,71 В/);
  assert.match(data, /Ключ заряда/);
  assert.match(data, /включён/);
  assert.match(data, /Короткое замыкание/);
  assert.match(data, /SW 4\.21-LFP/);
  assert.match(data, /0x17.05.2024|17\.05\.2024/);
  assert.match(data, /Счётчики срабатываний/);
  assert.match(data, /0x24|Перенапр/, 'битовые защиты и счётчики показаны');

  // вкладка записи: все регистры EEPROM, метки риска и байтовых полей
  const set = m.renderSettingsBody();
  assert.match(set, /Перенапряжение ячейки \(OVP\)/);
  assert.match(set, /3650/);
  assert.match(set, /0x24/);
  assert.match(set, /Таблица SOC/);
  assert.match(set, /старший байт/, 'байтовое поле подписано');
  assert.match(set, />риск</, 'рискованные регистры помечены');
  assert.match(set, /Балансировка разрешена/, 'маска показана битами');
  assert.match(set, /disabled=""[^>]*>Записать/, 'без изменений кнопка записи выключена');
  assert.doesNotMatch(set, /value="3600"/, 'поле показывает значение платы, а не выдумку');

  const tile = m.renderDataTile();
  assert.match(tile, /Все данные платы/);
  assert.match(tile, /Защита и настройки/);
  assert.match(tile, /Прошивка/);
  assert.match(m.renderDataEmpty(), /Банк не выбран|Читаю регистры/);

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

  // консоль регистров
  const con = m.renderConsole();
  assert.match(con, /Читать выбранное/);
  assert.match(con, /0x03/);
  assert.match(con, /Счётчики|0xAA/);
  assert.match(con, /Записать в банк/);
  assert.match(con, /заводской режим/);

  // подключение и журнал
  const connect = m.renderConnect();
  assert.match(connect, /\/dev\/ttyUSB0/);
  assert.match(connect, /занят банком/);
  assert.match(connect, /Найти и подключить все/);
  assert.match(connect, /Демо-банки/);
  assert.match(connect, /в отчёте 2 банка/);
  const jr = m.renderJournal();
  assert.match(jr, /Записано 2 рег\./);
  assert.match(jr, /связь потеряна/);

  // прошивка и обновления
  const fw = m.renderFirmware();
  assert.match(fw, /Запись отключена/);
  assert.match(fw, /Ошибки файла/);
  assert.match(fw, /неверная контрольная сумма/);
  assert.match(fw, /0x10/);
  const upd = m.renderUpdate();
  assert.match(upd, /Сборка программы/);
  assert.match(upd, /Доступна новая версия/);

  // вся панель: одна сетка, без вкладок-«сайта» и без схем
  const app = m.renderApp();
  assert.doesNotMatch(app, /role="tab"/, 'никаких вкладок-страниц');
  assert.match(app, /Отчёт по всем банкам/);
  assert.match(app, /Графики/);
  assert.match(app, /Плата: все данные и настройки/);
  assert.match(app, /Управление/);
  assert.match(app, /Консоль регистров/);
  assert.match(app, /data-density|data-area="bar"/);
  assert.doesNotMatch(app, /sc-box|sc-flow|АККУМУЛЯТОР/, 'схемы убраны: только данные и управление');
  assert.match(app, /Отчётом|CSV отчёт|CSV/);
});
