// Точка входа для ui-render.test.mjs: отрисовка экранов в строку (SSR).
import { renderToStaticMarkup } from 'react-dom/server';
import { Overview } from '../src/views/Overview';
import { Cells } from '../src/views/Cells';
import { Firmware } from '../src/views/Firmware';
import { UpdateDialog } from '../src/views/UpdateDialog';
import { Settings } from '../src/views/Settings';
import { Control } from '../src/views/Control';
import { PowerPanel } from '../src/views/Power';
import { ConnectionCard } from '../src/views/Connection';
import { PortHelp } from '../src/views/PortHelp';
import App from '../src/App';
import { pickPort } from '../src/ports';
import type { SettingsResponse, ScanResponse } from '../src/types';
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

export const renderPower = () => renderToStaticMarkup(<PowerPanel snap={snap} connected port="demo" demo />);
export const renderPowerDischargeOff = () => renderToStaticMarkup(
  <PowerPanel snap={{ ...snap, basic: { ...snap.basic, dischargeFetOn: false } }} connected port="/dev/ttyUSB0" demo={false} />,
);
export const renderPowerDisconnected = () => renderToStaticMarkup(<PowerPanel snap={null} connected={false} port={null} demo={false} />);

const portList = [
  { path: '/dev/ttyUSB0', label: '/dev/ttyUSB0 · QinHeng CH340 · 1a86:7523' },
  { path: '/dev/ttyUSB1', label: '/dev/ttyUSB1 · Silicon Labs CP210x · 10c4:ea60' },
];
const scanRes: ScanResponse = {
  at: 0,
  found: ['/dev/ttyUSB1'],
  results: [
    { path: '/dev/ttyUSB0', label: portList[0].label, found: false, reason: 'busy', deviceName: '', cellCount: 0, firmwareVersion: 0, detail: 'Permission denied' },
    { path: '/dev/ttyUSB1', label: portList[1].label, found: true, reason: '', deviceName: 'DEMO JBD 12S', cellCount: 12, firmwareVersion: 16, detail: '' },
  ],
};
const demoPort = { path: 'demo', label: 'Демо-режим (без платы)' };

export const renderConnectionScan = () => renderToStaticMarkup(
  <ConnectionCard
    ports={portList} demoPort={demoPort} selected="/dev/ttyUSB1" onSelect={() => {}} onRefresh={() => {}}
    connected={false} busy={false} scanning={false} scan={scanRes} portName={null} demo={false} deviceName=""
    onConnect={() => {}} onDisconnect={() => {}} onFind={() => {}} onConnectPath={() => {}}
  />,
);
export const renderConnectionEmpty = () => renderToStaticMarkup(
  <ConnectionCard
    ports={[]} demoPort={demoPort} selected="demo" onSelect={() => {}} onRefresh={() => {}}
    connected={false} busy={false} scanning={false} scan={null} portName={null} demo={false} deviceName=""
    onConnect={() => {}} onDisconnect={() => {}} onFind={() => {}} onConnectPath={() => {}}
  />,
);
export const renderPortHelp = () => renderToStaticMarkup(<PortHelp />);
export const renderPage = () => renderToStaticMarkup(<App />);
export const pick = (current: string, ports: string[], userChose: boolean) => pickPort(current, {
  ports: ports.map((path) => ({ path, label: path })),
  demo: demoPort,
}, userChose);
