// Точка входа для ui-render.test.mjs: SSR-рендер плиток панели и страницы целиком.
import { renderToStaticMarkup } from 'react-dom/server';
import { Firmware } from '../src/views/Firmware';
import { UpdateDialog } from '../src/views/UpdateDialog';
import { DataBody, DataTile, SettingsBody } from '../src/views/Editor';
import { BankTable, Charts, ConnectTile, KpiStrip } from '../src/views/Report';
import { ConsoleTile, ControlTile, Journal } from '../src/views/Ops';
import App from '../src/App';
import type { BankRegisters, BankRow, Catalog, FirmwareInfo, Panel, Series, UpdateSnapshot } from '../src/types';

const series: Series = {
  t: [1000, 2000, 3000, 4000],
  v: [39.7, 39.72, 39.68, 39.71],
  a: [-30.1, -28.4, -31.2, -29.9],
  w: [-1186, -1125, -1237, -1187],
  soc: [62, 62, 61, 61],
  rem: [62.1, 62.0, 61.9, 61.8],
  delta: [18, 21, 24, 22],
  min: [3300, 3298, 3295, 3297],
  max: [3318, 3319, 3319, 3319],
  bal: [1, 1, 0, 1],
  faults: [0, 0, 0, 0],
  temps: [[25.4, 25.6, 26.1, 26.4], [26.1, 26.2, 26.8, 27.0], [24.1, 24.2, 24.4, 24.5], []],
  step: 1,
  samples: 4,
};

const bank: BankRow = {
  id: 'b1', label: 'BANK A', path: '/dev/ttyUSB0', demo: false, connected: true, at: 4000, lastError: '', failures: 0,
  deviceName: 'JBD-12S-A', model: 'JBD-SP14S004', cellCount: 12, profile: 'discharge',
  voltage: 39.71, current: -29.9, power: -1187.1, remainingAh: 61.8, fullAh: 100, soc: 61, cycles: 127,
  cells: [3318, 3315, 3297, 3316, 3314, 3317, 3315, 3316, 3313, 3318, 3315, 3314],
  stats: { min: 3297, max: 3318, delta: 21, avg: 3314, minIndex: 2, maxIndex: 0, sum: 39758 },
  temperatures: [25.4, 26.1], chargeFetOn: true, dischargeFetOn: false, balancingCells: [3],
  faults: [{ key: 'covp', label: 'Перенапряжение ячейки' }], faultRaw: 1,
  errors: { sc: 0, chgoc: 2, dsgoc: 0, covp: 5, cuvp: 0, chgot: 0, chgut: 0, dsgot: 0, dsgut: 0, povp: 0, puvp: 1 },
  hwVersion: 'HW 1.3', swVersion: 'SW 4.21-LFP', serial: '12 34 05 00 42', prodDate: '17.05.2024', firmwareVersion: 16,
  spark: [{ t: 1000, soc: 62, v: 39.7, a: -30.1, delta: 18 }, { t: 2000, soc: 62, v: 39.72, a: -28.4, delta: 21 }],
};
const deadBank: BankRow = { ...bank, id: 'b2', label: 'BANK B', connected: false, voltage: null, current: null, power: null, soc: null, stats: null, cells: [], faults: [], temperatures: [], lastError: 'BMS не ответил' };
const banks = [bank, deadBank];

const fleet = {
  banks: 2, online: 1, stale: 1, voltageAvg: 39.71, currentSum: -29.9, powerSum: -1187.1, powerMax: 1187.1,
  socAvg: 61, ahSum: 61.8, ahCapacity: 100, cellMin: 3297, cellMax: 3318, cellDelta: 21, tempMax: 26.1,
  faults: 1, balancing: 1, cyclesMax: 127, chargeFetOff: 0, dischargeFetOff: 1,
};
const panel: Panel = { at: 4000, pollMs: 1000, lastPollAt: 4000, banks, fleet, focus: 'b1', series, fleetSeries: series };

const registers: BankRegisters = {
  at: 4000, id: 'b1', label: 'BANK A', port: '/dev/ttyUSB0', deviceName: 'JBD-12S-A', infoAt: 4000,
  info: { hw_version: 'HW 1.3', sw_version: 'SW 4.21-LFP', prod_date: '17.05.2024', serial: '12 34 05 00 42', life_cap: 4120000, model_name: 'JBD-SP14S004' },
  basic: {
    packVoltage: 39.71, packCurrent: -29.9, remainingAh: 61.8, fullAh: 100, capacityPct: 61, cycles: 127,
    manufactureDate: { year: 2024, month: 5, day: 17 }, cellCount: 12, ntcCount: 2, temperatures: [25.4, 26.1],
    chargeFetOn: true, dischargeFetOn: false, balancingCells: [3], faults: [{ key: 'covp', label: 'Перенапряжение ячейки' }],
    faultRaw: 1, firmwareVersion: 16,
  },
  cells: { values: bank.cells, stats: bank.stats },
  errors: bank.errors,
  settings: [
    { key: 'covp', label: 'Перенапряжение ячейки (OVP)', unit: 'мВ', value: 3650, editable: true, group: 'Напряжение ячейки', min: 2500, max: 4250, step: 1, reg: '0x24' },
    { key: 'soc_50', label: 'Напряжение ячейки для 50 %', unit: 'мВ', value: 3380, editable: true, group: 'Таблица SOC', min: 1500, max: 4300, step: 1, reg: '0x44' },
    { key: 'chg_ot_delay', label: 'Перегрев на разряде — задержка', unit: 'с', value: 2, editable: true, group: 'Задержки и индикация', min: 0, max: 255, step: 1, reg: '0x3a', byte: 'hi' },
    { key: 'func_mask', label: 'Функции платы', unit: '', value: 6, editable: true, group: 'Маски', min: 0, max: 65535, step: 1, reg: '0x2d', risky: true, bits: [{ mask: 4, key: 'balance', label: 'Балансировка разрешена' }] },
    { key: 'cell_cnt', label: 'Число ячеек (настройка)', unit: 'шт', value: 12, editable: false, reg: '0x2f' },
    { key: 'mfg_date_ee', label: 'Дата производства (EEPROM)', unit: '', value: '17.05.2024', editable: false, reg: '0x15' },
  ],
};

const catalog: Catalog = {
  settings: [
    { key: 'covp', label: 'Перенапряжение ячейки (OVP)', unit: 'мВ', reg: 36, hex: '0x24', kind: 'mv', byte: null, group: 'Напряжение ячейки', editable: true, risky: false, min: 2500, max: 4250, step: 1, bits: null },
  ],
  info: [
    { key: 'hw_version', reg: 6, label: 'Версия аппаратной части', kind: 'text', group: 'Паспорт', hex: '0x06' },
    { key: 'sw_version', reg: 7, label: 'Версия прошивки', kind: 'text', group: 'Паспорт', hex: '0x07' },
  ],
  control: [
    { key: 'fet', reg: 225, label: 'Ключи заряда и разряда', save: false, verified: true, note: 'бит 0 — выключить заряд' },
    { key: 'balance', reg: 226, label: 'Балансировка', save: false, verified: false, risky: true, note: '0x00EE — разрешить' },
  ],
  regs: [
    { reg: 3, label: 'Базовая информация о батарее', access: 'r', group: 'Данные' },
    { reg: 170, label: 'Счётчики срабатываний защит', access: 'r', group: 'Данные' },
    { reg: 36, label: 'Перенапряжение ячейки (OVP)', access: 'rw', group: 'Настройки' },
    { reg: 227, label: 'Мягкая перезагрузка платы', access: 'w', group: 'Управление', risky: true },
  ],
  faults: [{ bit: 0, key: 'covp', label: 'Перенапряжение ячейки' }, { bit: 10, key: 'sc', label: 'Короткое замыкание' }],
  errorCounters: [{ key: 'sc', label: 'Короткое замыкание' }, { key: 'covp', label: 'Перенапряжение ячейки' }],
  writable: ['covp'],
};

const noop = async () => null;

export const renderApp = () => renderToStaticMarkup(<App />);
export const renderBanks = () => renderToStaticMarkup(
  <BankTable banks={banks} focus="b1" faultLabels={{ covp: 'Перенапряжение ячейки' }}
    onFocus={() => {}} onRename={() => {}} onReconnect={() => {}} onRemove={() => {}} />,
);
export const renderBanksEmpty = () => renderToStaticMarkup(
  <BankTable banks={[]} focus={null} onFocus={() => {}} onRename={() => {}} onReconnect={() => {}} onRemove={() => {}} />,
);
export const renderKpis = () => renderToStaticMarkup(<KpiStrip panel={panel} bank={bank} series={series} isFleet={false} />);
export const renderKpisFleet = () => renderToStaticMarkup(<KpiStrip panel={panel} bank={null} series={series} isFleet />);
export const renderCharts = () => renderToStaticMarkup(<Charts series={series} bank={bank} catalog={catalog} registers={registers} />);
export const renderChartsNoData = () => renderToStaticMarkup(<Charts series={{ ...series, t: [], v: [] } as any} bank={null} catalog={catalog} registers={null} />);
export const renderDataTile = () => renderToStaticMarkup(
  <DataTile registers={registers} catalog={catalog} busy={null} bankName="BANK A" onRead={() => {}} onWrite={async () => null} />,
);
export const renderDataEmpty = () => renderToStaticMarkup(
  <DataTile registers={null} catalog={catalog} busy={null} bankName="" onRead={() => {}} onWrite={async () => null} />,
);
export const renderDataBody = () => renderToStaticMarkup(<DataBody registers={registers} catalog={catalog} />);
export const renderSettingsBody = () => renderToStaticMarkup(
  <SettingsBody registers={registers} catalog={catalog} busy={null} onWrite={async () => null} />,
);
export const renderControl = () => renderToStaticMarkup(
  <ControlTile bank={bank} busy={null} control={noop as any} catalog={catalog} onBackup={() => {}} onRestore={() => {}} panel={panel} />,
);
export const renderControlDisconnected = () => renderToStaticMarkup(
  <ControlTile bank={deadBank} busy={null} control={noop as any} catalog={catalog} onBackup={() => {}} onRestore={() => {}} panel={panel} />,
);
export const renderConsole = () => renderToStaticMarkup(
  <ConsoleTile catalog={catalog} bank={bank} busy={null} rawRead={noop as any} rawWrite={noop as any} />,
);
export const renderConnect = () => renderToStaticMarkup(
  <ConnectTile ports={[{ path: '/dev/ttyUSB0', label: '/dev/ttyUSB0 · CH340' }, { path: '/dev/ttyUSB1', label: '/dev/ttyUSB1 · CP210x', used: true } as any]}
    selected="/dev/ttyUSB0" onSelect={() => {}} onConnect={() => {}} onFind={() => {}} onDemo={() => {}}
    busy={null} scanning={false} banks={banks} catalog={catalog} />,
);
export const renderJournal = () => renderToStaticMarkup(
  <Journal log={[{ at: 4000, kind: 'err', text: 'Банк BANK B: связь потеряна' }, { at: 3000, kind: 'ok', text: 'Записано 2 рег.' }]} error="Банк BANK B: связь потеряна" />,
);

const fwInfo: FirmwareInfo = {
  fileName: 'bad.hex', ok: false, errors: ['строка 2: неверная контрольная сумма записи'], warnings: [],
  segments: [], bytes: 0, sizeKiB: 0, maxKiB: 512, minAddress: null, maxAddress: null, records: 1, sha256: null,
  canWrite: false, writeBlockedReason: 'Запись прошивки по UART ещё не реализована.',
};
export const renderFirmware = () => renderToStaticMarkup(
  <Firmware connected version="0x10" deviceName="JBD-12S-A" cellCount={12} onStateChange={() => {}} initialInfo={fwInfo} />,
);

const upd: UpdateSnapshot = {
  phase: 'ready', message: 'Доступна новая версия (abcdef1).', currentSha: '1111111aaaa', latestSha: 'abcdef1234567',
  latestDate: '2026-10-13T10:00:00Z', latestMessage: 'Большая панель', updateAvailable: true, branch: 'main',
  repo: 'danilka-revin/ploter_a1', checkedAt: 1,
  steps: [{ id: 'check', title: 'Проверка папки и ветки', state: 'done', detail: '' }, { id: 'build', title: 'Сборка программы', state: 'run', detail: '' }],
  restartRequired: false, running: false,
};
export const renderUpdate = () => renderToStaticMarkup(<UpdateDialog update={upd} onClose={() => {}} onCheck={() => {}} onRun={() => {}} />);
