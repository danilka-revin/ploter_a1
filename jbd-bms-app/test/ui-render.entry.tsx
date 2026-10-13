// Точка входа для ui-render.test.mjs: отрисовка экранов в строку (SSR).
import { renderToStaticMarkup } from 'react-dom/server';
import { Overview } from '../src/views/Overview';
import { Cells } from '../src/views/Cells';
import { Firmware } from '../src/views/Firmware';
import { UpdateDialog } from '../src/views/UpdateDialog';
import { Settings } from '../src/views/Settings';
import { Control } from '../src/views/Control';
import type { SettingsResponse } from '../src/types';
import type { Snapshot, FirmwareInfo, UpdateSnapshot } from '../src/types';

const snap: Snapshot = {
  at: 0,
  port: 'demo',
  demo: true,
  deviceName: 'DEMO JBD 4S 12V',
  basic: {
    packVoltage: 13.27,
    packCurrent: -1.62,
    remainingAh: 62.01,
    fullAh: 100,
    capacityPct: 62,
    cycles: 127,
    manufactureDate: { year: 2024, month: 5, day: 17 },
    cellCount: 4,
    ntcCount: 2,
    temperatures: [25.4, 26.1],
    chargeFetOn: true,
    dischargeFetOn: true,
    balancingCells: [3],
    faults: [],
    faultRaw: 0,
    firmwareVersion: 16,
  },
  cells: {
    values: [3315, 3322, 3322, 3307],
    stats: { min: 3307, max: 3322, delta: 15, avg: 3317, minIndex: 3, maxIndex: 1 },
  },
  errors: { sc: 0, covp: 0 },
};

const faultySnap: Snapshot = {
  ...snap,
  basic: { ...snap.basic, faults: [{ key: 'covp', label: 'Перенапряжение ячейки' }] },
};

const fwInfo: FirmwareInfo = {
  fileName: 'bad.hex',
  ok: false,
  errors: ['строка 2: неверная контрольная сумма записи'],
  warnings: [],
  segments: [],
  bytes: 0,
  sizeKiB: 0,
  maxKiB: 512,
  minAddress: null,
  maxAddress: null,
  records: 1,
  sha256: null,
  canWrite: false,
  writeBlockedReason: 'Запись прошивки по UART ещё не реализована.',
};

const upd: UpdateSnapshot = {
  phase: 'ready',
  message: 'Доступна новая версия (abcdef1).',
  currentSha: '1111111aaaa',
  latestSha: 'abcdef1234567',
  latestDate: '2026-10-13T10:00:00Z',
  latestMessage: 'Добавлен экран ячеек',
  updateAvailable: true,
  branch: 'main',
  repo: 'https://github.com/danilka-revin/ploter_a1.git',
  checkedAt: 1,
  steps: [
    { id: 'check', title: 'Проверка папки и ветки', state: 'done', detail: '' },
    { id: 'build', title: 'Сборка программы', state: 'run', detail: '' },
  ],
  restartRequired: false,
  running: false,
};

export const renderCells = () => renderToStaticMarkup(<Cells snap={snap} connected error="" />);
export const renderOverview = () => renderToStaticMarkup(<Overview snap={snap} connected error="" />);
export const renderOverviewWithFault = () => renderToStaticMarkup(<Overview snap={faultySnap} connected error="" />);
export const renderOverviewDisconnected = () => renderToStaticMarkup(<Overview snap={null} connected={false} error="" />);
export const renderFirmwareWithFile = () => renderToStaticMarkup(
  <Firmware connected snap={snap} onStateChange={() => {}} initialInfo={fwInfo} />,
);
export const renderUpdate = () => renderToStaticMarkup(
  <UpdateDialog update={upd} onClose={() => {}} onCheck={() => {}} onRun={() => {}} />,
);

export const renderSettingsIdle = () => renderToStaticMarkup(<Settings connected />);
export const renderSettingsDisconnected = () => renderToStaticMarkup(<Settings connected={false} />);

const settingsData: SettingsResponse = {
  at: 0,
  items: [
    { key: 'covp', label: 'Перенапряжение ячейки (OVP)', unit: 'мВ', value: 3650, editable: true, group: 'Напряжение ячейки', min: 2500, max: 4250, step: 1 },
    { key: 'chgoc', label: 'Перегрузка по заряду', unit: 'мА', value: 40000, editable: true, group: 'Токи', min: 1000, max: 200000, step: 10 },
    { key: 'chgot', label: 'Перегрев при заряде', unit: '°C', value: 45, editable: true, group: 'Температура', min: -20, max: 80, step: 0.1 },
    { key: 'cell_cnt', label: 'Число ячеек (настройка)', unit: 'шт', value: 12, editable: false },
  ],
};
export const renderSettingsWithData = () => renderToStaticMarkup(<Settings connected initialData={settingsData} />);

export const renderControl = () => renderToStaticMarkup(<Control snap={snap} connected />);
