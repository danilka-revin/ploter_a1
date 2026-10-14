// Типы ответов API (scripts/server.mjs). Держать в соответствии с сервером.

export interface PortItem { path: string; label: string }

export interface PortsResponse {
  ports: PortItem[];
  demo: PortItem;
}

export interface Basic {
  packVoltage: number;      // В
  packCurrent: number;      // А, минус — разряд
  remainingAh: number;      // Ач
  fullAh: number;           // Ач
  capacityPct: number;      // %
  cycles: number;
  manufactureDate: { year: number; month: number; day: number };
  cellCount: number;
  ntcCount: number;
  temperatures: number[];   // °C
  chargeFetOn: boolean;
  dischargeFetOn: boolean;
  balancingCells: number[]; // номера ячеек с 1
  faults: { key: string; label: string }[];
  faultRaw: number;
  firmwareVersion: number;
}

export interface CellStats {
  min: number;
  max: number;
  delta: number;
  avg: number;
  minIndex: number;
  maxIndex: number;
  sum?: number;
}

export interface Snapshot {
  at: number;
  port: string | null;
  demo: boolean;
  deviceName: string;
  basic: Basic;
  cells: { values: number[]; stats: CellStats | null };
  errors: Record<string, number> | null;
}

export interface SettingItem {
  key: string;
  label: string;
  unit: string;
  value: number | string | null;
  error?: string;
  /** можно менять из приложения */
  editable?: boolean;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  /** адрес регистра, напр. 0x24 */
  reg?: string;
  /** поле занимает один байт регистра */
  byte?: 'hi' | 'lo' | null;
  /** запись меняет поведение платы (аппаратные защиты, маски, калибровка) */
  risky?: boolean;
  /** побитовые поля (маски функций) */
  bits?: { mask: number; key: string; label: string }[] | null;
}

export interface SettingsResponse {
  at: number;
  items: SettingItem[];
}

export interface WriteItem {
  key: string;
  label: string;
  unit: string;
  before: number | null;
  requested: number;
  actual: number | null;
  ok: boolean;
}

export interface WriteResponse {
  ok: boolean;
  saved: boolean;
  changed: number;
  items: WriteItem[];
  message: string;
}

export interface ConnectResponse {
  connected: boolean;
  port: string;
  demo: boolean;
  deviceName: string;
  firmwareVersion: number;
  cellCount: number;
}

export interface AppState {
  connected: boolean;
  port: string | null;
  demo: boolean;
  deviceName: string;
  lastError: string;
  firmwareLoaded: boolean;
  firmwareName: string;
}

export interface FirmwareInfo {
  fileName: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  segments: { address: number; length: number }[];
  bytes: number;
  sizeKiB: number;
  maxKiB: number;
  minAddress: number | null;
  maxAddress: number | null;
  records: number;
  sha256: string | null;
  canWrite: boolean;
  writeBlockedReason: string | null;
}

export type UpdatePhase = 'idle' | 'checking' | 'ready' | 'running' | 'done' | 'error' | 'unsupported';

export interface UpdateStep {
  id: string;
  title: string;
  state: 'wait' | 'run' | 'done' | 'skip' | 'error';
  detail: string;
}

export interface UpdateSnapshot {
  phase: UpdatePhase;
  message: string;
  currentSha: string;
  latestSha: string;
  latestDate: string;
  latestMessage: string;
  updateAvailable: boolean;
  branch: string;
  repo: string;
  checkedAt: number;
  steps: UpdateStep[];
  restartRequired: boolean;
  running: boolean;
}

export interface Health {
  ok: boolean;
  app: string;
  commit: string;
}

export interface ScanResult {
  path: string;
  label: string;
  found: boolean;
  /** busy — порт не открылся; silent — порт открылся, плата не ответила */
  reason: '' | 'busy' | 'silent';
  deviceName: string;
  cellCount: number;
  firmwareVersion: number;
  detail: string;
}

export interface ScanResponse {
  at: number;
  results: ScanResult[];
  found: string[];
}

// ---------- панель: банками управляет сервер (scripts/banks.mjs) ----------

export interface SparkPoint { t: number; soc: number | null; v: number | null; a: number | null; delta: number | null }

export interface BankRow {
  id: string;
  label: string;
  path: string;
  demo: boolean;
  connected: boolean;
  at: number;
  lastError: string;
  failures: number;
  deviceName: string;
  model: string;
  cellCount: number;
  profile?: string;
  voltage: number | null;
  current: number | null;
  power: number | null;
  remainingAh: number | null;
  fullAh: number | null;
  soc: number | null;
  cycles: number | null;
  cells: number[];
  stats: CellStats | null;
  temperatures: number[];
  chargeFetOn: boolean | null;
  dischargeFetOn: boolean | null;
  balancingCells: number[];
  faults: { key: string; label: string }[];
  faultRaw: number;
  errors: Record<string, number> | null;
  hwVersion: string;
  swVersion: string;
  serial: string;
  prodDate: string;
  firmwareVersion: number | null;
  spark: SparkPoint[];
}

export interface Fleet {
  banks: number;
  online: number;
  stale: number;
  voltageAvg: number | null;
  currentSum: number | null;
  powerSum: number | null;
  powerMax: number | null;
  socAvg: number | null;
  ahSum: number | null;
  ahCapacity: number | null;
  cellMin: number | null;
  cellMax: number | null;
  cellDelta: number | null;
  tempMax: number | null;
  faults: number;
  balancing: number;
  cyclesMax: number | null;
  chargeFetOff: number;
  dischargeFetOff: number;
}

/** Ряды для графиков: null — пропуск (плата молчала в этот момент). */
export interface Series {
  t: number[];
  v: (number | null)[];
  a: (number | null)[];
  w: (number | null)[];
  soc: (number | null)[];
  rem: (number | null)[];
  delta: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
  avg?: (number | null)[];
  cells?: (number | null)[][];
  bal: (number | null)[];
  faults: (number | null)[];
  temps: (number | null)[][];
  step: number;
  samples: number;
}

export interface Panel {
  at: number;
  pollMs: number;
  lastPollAt: number;
  banks: BankRow[];
  fleet: Fleet;
  focus: string | null;
  series: Series | null;
  fleetSeries: Series | null;
}

export interface CatalogBit { mask: number; key: string; label: string }

export interface CatalogSetting {
  key: string;
  label: string;
  unit: string;
  reg: number;
  hex: string;
  kind: string;
  byte: 'hi' | 'lo' | null;
  group: string;
  editable: boolean;
  risky: boolean;
  min: number | null;
  max: number | null;
  step: number | null;
  bits: CatalogBit[] | null;
}

export interface CatalogReg { reg: number; label: string; access: 'r' | 'w' | 'rw'; group: string; note?: string; risky?: boolean }

export interface CatalogControl {
  key: string;
  reg: number | null;
  label: string;
  save: boolean;
  verified: boolean;
  note: string;
  risky?: boolean;
}

export interface Catalog {
  settings: CatalogSetting[];
  info: { key: string; reg: number; label: string; kind: string; group: string; unit?: string; hex?: string }[];
  control: CatalogControl[];
  regs: CatalogReg[];
  faults: { bit: number; key: string; label: string }[];
  errorCounters: { key: string; label: string }[];
  writable: string[];
}

export interface BankRegisters {
  at: number;
  id: string;
  label: string;
  port: string;
  info: Record<string, string | number | null>;
  infoAt: number;
  deviceName: string;
  basic: Basic | null;
  cells: { values: number[]; stats: CellStats | null } | null;
  errors: Record<string, number> | null;
  settings: SettingItem[];
}

export interface RawRegItem {
  reg: number;
  hex: string;
  ok: boolean;
  bytes: string[];
  text: string;
  u16: number | null;
  temp: number | null;
  error: string;
  length?: number;
}

export interface RawReadResponse { at: number; id: string; items: RawRegItem[] }

export interface RawWriteResponse {
  ok: boolean;
  reg: number;
  hex: string;
  sent: number[];
  read: { bytes: string[]; u16: number | null } | null;
  message: string;
}

export interface ControlResult {
  id: string;
  label: string;
  ok?: boolean;
  message?: string;
  chargeFetOn?: boolean;
  dischargeFetOn?: boolean;
  balance?: boolean;
  remainingAh?: number;
  fullAh?: number;
  errors?: Record<string, number>;
}

export interface ControlResponse { action: string; results: ControlResult[]; ok: boolean }

export interface ReportBank extends BankRow {
  info: Record<string, string | number | null> | null;
  infoAt: number;
  settings: SettingItem[] | null;
}

export interface Report {
  at: number;
  app: string;
  fleet: Fleet;
  banks: ReportBank[];
}

export interface PortsResponseExtended extends PortsResponse {
  ports: (PortItem & { used?: boolean })[];
}

export interface PrinterStatus {
  configured: boolean;
  path: string;
  baudRate: number;
  width: number;
  /** язык чека: всегда английский (только ASCII — печатается любым принтером) */
  language: 'en';
  open: boolean;
  lastError: string;
  lastPrintAt: number;
  bauds: number[];
}

/** Чек обычным текстом, как он ляжет на бумагу (GET /api/printer/preview). */
export interface PrinterPreview {
  kind: 'bank' | 'fleet' | 'test';
  width: number;
  lines: string[];
}

export interface PrintResult {
  ok: boolean;
  at: number;
  path?: string;
  baudRate?: number;
  bank?: string;
  banks?: number;
}
