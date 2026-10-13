// Плитки управления: команды платы (ключи, балансировка, остаток, сбросы),
// консоль сырых регистров и журнал событий.
import { useMemo, useState } from 'react';
import { Armed, Btn, Chip, ConfirmButton, KV, num } from './Tile';
import type { BankRow, Catalog, RawRegItem } from '../types';

type Action = 'fet' | 'balance' | 'capacity' | 'clear-errors' | 'soc-reset' | 'soft-reset';

export function ControlTile({
  bank, busy, control, catalog, onBackup, onRestore, panel,
}: {
  bank: BankRow | null;
  busy: string | null;
  control: (action: Action, payload?: Record<string, unknown>, all?: boolean) => Promise<any>;
  catalog: Catalog | null;
  onBackup: () => void;
  onRestore: (file: File | null) => void;
  panel: { banks: BankRow[] } | null;
}) {
  const [all, setAll] = useState(false);
  const [ah, setAh] = useState<string | null>(null);
  const [balOn, setBalOn] = useState(true);
  const disabled = !bank?.connected;
  const meta = (key: string) => catalog?.control.find((c) => c.key === key);
  const targets = all ? (panel?.banks.length ?? 0) : 1;
  const capacity = ah ?? String(bank?.remainingAh ?? 0);
  const apply = (action: Action, payload: Record<string, unknown> = {}) => control(action, { ...payload, all }, all);

  return (
    <div className="ops">
      <div className="ops-head">
        <Chip on={all} onClick={() => setAll(!all)} title="Отправить команду всем банкам сразу">
          {all ? `всем банкам (${panel?.banks.length ?? 0})` : 'выбранному банку'}
        </Chip>
        <span className="muted small">{bank ? `цель: ${bank.label}` : 'банк не выбран'}</span>
        {targets > 1 && <span className="tagm risk">команда уйдёт на {targets} плат</span>}
      </div>

      <div className="fet-grid">
        <ConfirmButton
          on={Boolean(bank?.chargeFetOn)} labelOn="заряд включён" labelOff="заряд выключен"
          disabled={disabled} busy={busy === 'fet'}
          title={`${meta('fet')?.note ?? 'регистр 0xE1'} · ${meta('fet')?.save ? 'с сохранением' : 'без сохранения в память платы'}`}
          onConfirm={(next) => apply('fet', { charge: next, discharge: Boolean(bank?.dischargeFetOn) })}
        />
        <ConfirmButton
          on={Boolean(bank?.dischargeFetOn)} labelOn="разряд включён" labelOff="разряд выключен"
          disabled={disabled} busy={busy === 'fet'} tone="danger"
          title="выключенный разряд отключает нагрузку от батареи"
          onConfirm={(next) => apply('fet', { charge: Boolean(bank?.chargeFetOn), discharge: next })}
        />
        <Armed
          label={`Балансировка: ${balOn ? 'разрешена' : 'запрещена'}`} confirmLabel={balOn ? 'Запретить балансировку' : 'Разрешить балансировку'}
          onClick={() => { setBalOn(!balOn); apply('balance', { on: !balOn }); }}
          disabled={disabled} busy={busy === 'balance'} tone="ok"
          title={`${meta('balance')?.note ?? 'регистр 0xE2'} — состояние не читается, панель помнит вашу последнюю команду`}
        />
        <Armed
          label="Сбросить счётчики защит" confirmLabel="Подтвердите сброс счётчиков"
          onClick={() => apply('clear-errors')}
          disabled={disabled} busy={busy === 'clear-errors'}
          title="обнуляет счётчики срабатываний 0xAA (с сохранением в память платы)"
        />
      </div>

      <div className="cap-row">
        <label>
          <span>остаток ёмкости, Ач</span>
          <input
            type="number" step="0.1" min={0} max={bank?.fullAh ?? 1000} value={capacity}
            disabled={disabled} onChange={(e) => setAh(e.target.value)}
          />
        </label>
        <input
          className="slider" type="range" min={0} max={bank?.fullAh ?? 100} step={0.1}
          value={Math.min(Number(capacity) || 0, bank?.fullAh ?? 100)} disabled={disabled}
          onChange={(e) => setAh(e.target.value)}
        />
        <Btn tone="primary" disabled={disabled || busy === 'capacity'} onClick={() => apply('capacity', { ah: Number(String(capacity).replace(',', '.')) })}>
          {busy === 'capacity' ? 'Пишу…' : 'Задать'}
        </Btn>
        <Btn onClick={() => setAh(null)} disabled={ah === null} title="вернуть показание платы">сбросить</Btn>
      </div>

      <div className="ops-files">
        <Btn onClick={onBackup} disabled={disabled} title="сохранить все настройки банка в JSON">Копия настроек</Btn>
        <label className="file">
          <input type="file" accept="application/json,.json" onChange={(e) => onRestore(e.target.files?.[0] ?? null)} disabled={disabled} />
          <span>Восстановить</span>
        </label>
        <Armed tone="danger" disabled={disabled} label="Пересчитать SOC" confirmLabel="Подтвердите пересчёт SOC"
          busy={busy === 'soc-reset'} title={meta('soc_reset')?.note} onClick={() => apply('soc-reset', { risk: true })} />
        <Armed tone="danger" disabled={disabled} label="Перезагрузить плату" confirmLabel="Подтвердите перезагрузку"
          busy={busy === 'soft-reset'} title={meta('soft_reset')?.note} onClick={() => apply('soft-reset', { risk: true })} />
      </div>
      <p className="muted tiny">Команды «Пересчитать SOC» и «Перезагрузить плату» помечены как непроверенные для вашей модели: они выполняются только с явным подтверждением риска.</p>
    </div>
  );
}

/** Консоль сырых регистров: прочитать что угодно и записать что угодно (с подтверждением). */
export function ConsoleTile({
  catalog, bank, busy, rawRead, rawWrite,
}: {
  catalog: Catalog | null;
  bank: BankRow | null;
  busy: string | null;
  rawRead: (regs: number[]) => Promise<{ items: RawRegItem[] } | null>;
  rawWrite: (body: { reg: number; raw?: number; bytes?: number[]; factory?: boolean; password?: string; risk?: boolean }) => Promise<any>;
}) {
  const regs = catalog?.regs ?? [];
  const groups = useMemo(() => [...new Set(regs.map((r) => r.group))], [regs]);
  const [group, setGroup] = useState('');
  const [picked, setPicked] = useState<number[]>([0x03, 0x04, 0x05, 0xaa]);
  const [rows, setRows] = useState<RawRegItem[]>([]);
  const [writeReg, setWriteReg] = useState('0x24');
  const [writeVal, setWriteVal] = useState('3650');
  const [factory, setFactory] = useState(true);
  const [password, setPassword] = useState('');
  const [risk, setRisk] = useState(false);
  const [note, setNote] = useState('');

  const visible = group ? regs.filter((r) => r.group === group) : regs;
  const risky = useMemo(() => new Set(regs.filter((r) => r.risky).map((r) => r.reg)), [regs]);

  const readPicked = async () => {
    const r = await rawRead(picked);
    if (r) setRows(r.items);
  };
  const readGroup = async () => {
    const list = visible.map((v) => v.reg).slice(0, 120);
    setPicked(list);
    const r = await rawRead(list);
    if (r) {
      setRows(r.items);
      setNote(`Прочитано ${r.items.filter((i) => i.ok).length} регистров из ${r.items.length}.`);
    }
  };
  const doWrite = async () => {
    const reg = parseReg(writeReg);
    if (reg === null) { setNote('Регистр — 0xNN или число 0…255.'); return; }
    const value = parseReg(writeVal);
    const bytes = writeVal.trim().split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x, 16));
    const useBytes = bytes.length > 1 && bytes.every((b) => Number.isFinite(b));
    const r = await rawWrite({
      reg,
      ...(useBytes ? { bytes } : { raw: value ?? 0 }),
      factory,
      password,
      risk: risk || !risky.has(reg),
    });
    if (r) {
      setNote(r.message);
      setRows((cur) => [r.read ? { reg, hex: r.hex, ok: true, bytes: r.read.bytes, text: '', u16: r.read.u16, temp: null, error: '' } : { reg, hex: r.hex, ok: false, bytes: r.sent, text: '', u16: null, temp: null, error: 'регистр не читается' }, ...cur]);
    }
  };

  return (
    <div className="console">
      <div className="tools">
        <span className="muted small">выбрано регистров: <b>{picked.length}</b></span>
        <Btn small onClick={readPicked} disabled={busy === 'raw' || !bank?.connected}>{busy === 'raw' ? 'Читаю…' : 'Читать выбранное'}</Btn>
        <Btn small onClick={readGroup} disabled={busy === 'raw' || !bank?.connected}>Читать всю группу</Btn>
        <select value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">все группы</option>
          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </div>
      <div className="reg-list">
        {visible.slice(0, 400).map((r) => {
          const on = picked.includes(r.reg);
          return (
            <span key={`${r.group}-${r.reg}`} className={`reg ${on ? 'on' : ''} ${risky.has(r.reg) ? 'risk' : ''}`}
              title={`${r.label}${r.note ? ` — ${r.note}` : ''} · доступ: ${r.access === 'w' ? 'только запись' : r.access === 'rw' ? 'чтение и запись' : 'только чтение'}`}
              onClick={() => setPicked(on ? picked.filter((x) => x !== r.reg) : [...picked, r.reg])}>
              <i>{hex(r.reg)}</i>{shortLabel(r.label)}
            </span>
          );
        })}
      </div>
      <div className="console-grid">
        <table className="grid-table raw">
          <thead><tr><th>рег</th><th>байты</th><th className="n">u16</th><th className="n">T</th><th>текст / ошибка</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.hex}-${i}`} className={r.ok ? '' : 'is-err'}>
                <td className="mono">{r.hex}</td>
                <td className="mono small">{r.bytes.slice(0, 12).join(' ')}{r.bytes.length > 12 ? ' …' : ''}</td>
                <td className="n mono">{r.u16 ?? '—'}</td>
                <td className="n mono">{r.temp != null && r.length === 2 ? r.temp.toFixed(1) : '—'}</td>
                <td className="small">{r.ok ? (r.text || '—') : <span className="warn">{r.error}</span>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="muted center">Нажмите «Читать выбранное» — ответ платы появится здесь.</td></tr>}
          </tbody>
        </table>
        <div className="write-box">
          <KV k="регистра" v={<input value={writeReg} onChange={(e) => setWriteReg(e.target.value)} />} />
          <KV k="значение" v={<input value={writeVal} onChange={(e) => setWriteVal(e.target.value)} placeholder="u16 0…65535 или «A5 5A»" />} />
          <KV k="режим" v={<span className="row-inline"><Chip on={factory} onClick={() => setFactory(!factory)} title="запись через пароль и заводской режим, как в bms-tools">{factory ? 'заводской режим' : 'прямая запись'}</Chip></span>} />
          <KV k="пароль" v={<input value={password} onChange={(e) => setPassword(e.target.value)} maxLength={6} placeholder="— — — — — —" />} />
          <KV k="риск" v={<label className="chk"><input type="checkbox" checked={risk} onChange={(e) => setRisk(e.target.checked)} /> понимаю, что регистр может сломать защиту</label>} />
          <Btn tone="danger" onClick={doWrite} disabled={busy === 'raw-write' || !bank?.connected}>{busy === 'raw-write' ? 'Пишу…' : 'Записать в банк'}</Btn>
          {note && <p className="muted tiny">{note}</p>}
        </div>
      </div>
    </div>
  );
}

export function Journal({ log, error }: { log: { at: number; kind: string; text: string }[]; error: string }) {
  return (
    <div className="journal">
      {error && <div className="banner err">{error}</div>}
      {!log.length && <span className="muted">Журнал пуст: подключения, записи и команды появятся здесь.</span>}
      {log.map((l, i) => (
        <div key={`${l.at}-${i}`} className={`lg lg-${l.kind}`}>
          <span className="t">{new Date(l.at).toLocaleTimeString('ru-RU')}</span>
          <span className="x">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

function parseReg(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const n = s.startsWith('0x') ? parseInt(s.slice(2), 16) : Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 0xff ? n : null;
}

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;

function shortLabel(s: string) {
  return s.length > 46 ? `${s.slice(0, 45)}…` : s;
}
