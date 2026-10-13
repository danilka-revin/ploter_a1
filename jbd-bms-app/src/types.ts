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
  value: number | null;
  error?: string;
  /** можно менять из приложения */
  editable?: boolean;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
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
