// Плитка «Плата: данные и настройки»: сводка по банкам и плате (read-only),
// форма записи порогов защит, балансировки и таблицы SOC, и экран проверки прошивки.
// Никаких сырых номеров регистров: только понятные параметры аккумулятора и банок.
import { useMemo, useState } from 'react';
import { Btn, Chip, KV, NumField, num } from './Tile';
import { Firmware } from './Firmware';
import type { BankRegisters, Catalog, SettingItem } from '../types';

type Tab = 'data' | 'settings' | 'firmware';

export function DataTile({
  registers, catalog, busy, onRead, onWrite, bankName,
}: {
  registers: BankRegisters | null;
  catalog: Catalog | null;
  busy: string | null;
  onRead: () => void;
  onWrite: (changes: Record<string, number>, opts: { password: string; save: boolean; risk: boolean }) => Promise<any>;
  bankName: string;
}) {
  const [tab, setTab] = useState<Tab>('data');
  const ready = Boolean(registers);
  return (
    <div className="editor">
      <div className="tabs">
        <button className={tab === 'data' ? 'on' : ''} onClick={() => setTab('data')}>Все данные платы</button>
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
          Защита и настройки
        </button>
        <button className={tab === 'firmware' ? 'on' : ''} onClick={() => setTab('firmware')}>Прошивка</button>
        <span className="sp" />
        <Btn small onClick={onRead} disabled={busy === 'registers' || !bankName} title="Перечитать данные и настройки платы">
          {busy === 'registers' ? 'Читаю…' : 'Обновить'}
        </Btn>
      </div>
      {!ready ? (
        <div className="blank">
          <b>{bankName ? 'Читаю данные платы…' : 'Банк не выбран'}</b>
          <p>{bankName
            ? 'Запрашиваю параметры банок, паспорт платы и настройки защиты.'
            : 'Выберите аккумулятор слева или подключите плату — здесь появятся сводка по банкам, защиты и пороги.'}</p>
        </div>
      ) : tab === 'data' ? (
        <DataBody registers={registers!} catalog={catalog} />
      ) : tab === 'firmware' ? (
        <Firmware
          connected={Boolean(registers && bankName)}
          version={registers?.basic ? `0x${(registers.basic.firmwareVersion ?? 0).toString(16).toUpperCase().padStart(2, '0')}` : '—'}
          deviceName={registers?.deviceName ?? ''}
          cellCount={registers?.basic?.cellCount ?? null}
          onStateChange={() => {}}
        />
      ) : (
        <SettingsBody registers={registers!} catalog={catalog} busy={busy} onWrite={onWrite} />
      )}
    </div>
  );
}

/* ---------------- данные ---------------- */

export function DataBody({ registers, catalog }: { registers: BankRegisters; catalog: Catalog | null }) {
  const b = registers.basic;
  const info = registers.info ?? {};
  const faults = new Set((b?.faults ?? []).map((f) => f.key));
  const counters = registers.errors ?? null;
  const faultBits = catalog?.faults ?? [];
  const cellCount = b?.cellCount ?? registers.cells?.values.length ?? 0;
  return (
    <div className="data-grid">
      <section>
        <h5>Банки в аккумуляторе</h5>
        {registers.cells?.stats ? (
          <>
            <KV k="Схема банок" v={`${cellCount}S · ${cellCount} шт`} />
            <KV k="Минимум" v={`${(registers.cells.stats.min / 1000).toFixed(3)} В · №${registers.cells.stats.minIndex + 1}`} />
            <KV k="Максимум" v={`${(registers.cells.stats.max / 1000).toFixed(3)} В · №${registers.cells.stats.maxIndex + 1}`} />
            <KV k="Среднее" v={`${(registers.cells.stats.avg / 1000).toFixed(3)} В`} />
            <KV k="Разброс" v={`${registers.cells.stats.delta} мВ`} tone={registers.cells.stats.delta > 30 ? 'warn' : 'ok'} />
            <KV k="Сумма банок" v={`${((registers.cells.stats.sum ?? 0) / 1000).toFixed(2)} В`} />
            <KV k="Балансируются" v={b?.balancingCells.length ? b.balancingCells.map((i) => `№${i}`).join(' ') : 'никто'} />
            <div className="cell-numbers">
              {registers.cells.values.map((v, i) => (
                <span key={i} className={b?.balancingCells.includes(i + 1) ? 'bal' : ''}><i>{i + 1}</i>{(v / 1000).toFixed(3)}</span>
              ))}
            </div>
          </>
        ) : <p className="muted small">Плата не вернула напряжения банок.</p>}
      </section>

      <section>
        <h5>Батарея</h5>
        <KV k="Напряжение сборки" v={`${num(b?.packVoltage ?? null, 2)} В`} />
        <KV k="Ток" v={`${num(b?.packCurrent ?? null, 2)} А`} tone={b && b.packCurrent < 0 ? 'neg' : 'pos'} />
        <KV k="Остаток" v={`${num(b?.remainingAh ?? null, 2)} Ач · ${b?.capacityPct ?? '—'} %`} />
        <KV k="Полная ёмкость" v={`${num(b?.fullAh ?? null, 2)} Ач`} />
        <KV k="Циклов" v={String(b?.cycles ?? '—')} />
        <KV k="Датчиков температуры" v={`${b?.ntcCount ?? '—'}`} />
        <KV k="Дата выпуска" v={b?.manufactureDate ? `${pad(b.manufactureDate.day)}.${pad(b.manufactureDate.month)}.${b.manufactureDate.year}` : '—'} />
        <h5 className="mt">Температуры</h5>
        {(b?.temperatures ?? []).length
          ? b!.temperatures.map((t, i) => <KV key={i} k={`Датчик ${i + 1}`} v={`${t.toFixed(1)} °C`} tone={t > 45 ? 'warn' : ''} />)
          : <p className="muted small">Датчики не сообщены.</p>}
      </section>

      <section>
        <h5>Ключи и защита</h5>
        <KV k="Ключ заряда" v={b?.chargeFetOn ? 'включён' : 'выключен'} tone={b?.chargeFetOn ? 'ok' : 'warn'} />
        <KV k="Ключ разряда" v={b?.dischargeFetOn ? 'включён' : 'выключен'} tone={b?.dischargeFetOn ? 'ok' : 'warn'} />
        <div className="bitgrid">
          {faultBits.map((f) => (
            <span key={f.key} className={`bitrow ${faults.has(f.key) ? 'on' : ''}`}>
              <i className="dot" />{f.label}
            </span>
          ))}
        </div>
        <h5 className="mt">Счётчики срабатываний</h5>
        <div className="counters">
          {(catalog?.errorCounters ?? []).map((c) => (
            <span key={c.key} className={(counters?.[c.key] ?? 0) ? 'on' : ''} title={c.label}>
              <i>{short(c.label)}</i><b>{counters ? counters[c.key] ?? 0 : '—'}</b>
            </span>
          ))}
        </div>
      </section>

      <section>
        <h5>Паспорт платы</h5>
        {(catalog?.info ?? []).map((i) => (
          <KV key={i.key} k={i.label} v={textOrDash(info[i.key])} />
        ))}
        <KV k="Имя устройства" v={textOrDash(registers.deviceName)} />
        <KV k="Порт" v={`${registers.port} · обновлено ${new Date(registers.at).toLocaleTimeString('ru-RU')}`} />
      </section>
    </div>
  );
}

/* ---------------- настройки: чтение и запись ---------------- */

export function SettingsBody({
  registers, busy, onWrite,
}: {
  registers: BankRegisters;
  catalog?: Catalog | null;
  busy: string | null;
  onWrite: (changes: Record<string, number>, opts: { password: string; save: boolean; risk: boolean }) => Promise<any>;
}) {
  const items = registers.settings ?? [];
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<string>('');
  const [onlyDirty, setOnlyDirty] = useState(false);
  const [password, setPassword] = useState('');
  const [save, setSave] = useState(true);
  const [risk, setRisk] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [checked, setChecked] = useState(false);

  const groups = useMemo(() => [...new Set(items.map((i) => i.group ?? 'Прочее'))], [items]);
  const changes = useMemo(() => {
    const out: { key: string; label: string; unit: string; before: number | string | null; after: number; item: SettingItem }[] = [];
    for (const it of items) {
      const raw = draft[it.key];
      if (raw === undefined) continue;
      const after = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(after)) continue;
      if (Number(it.value) === after) continue;
      out.push({ key: it.key, label: it.label, unit: it.unit, before: it.value, after, item: it });
    }
    return out;
  }, [draft, items]);
  const needsRisk = changes.some((c) => c.item.risky);
  const invalid = changes.some((c) => {
    const { min, max, step } = c.item;
    if (min != null && c.after < min) return true;
    if (max != null && c.after > max) return true;
    if (step && Math.abs(c.after / step - Math.round(c.after / step)) > 1e-6) return true;
    return false;
  });

  const shown = items.filter((it) => {
    if (onlyDirty && !(it.key in draft)) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return it.label.toLowerCase().includes(q) || (it.group ?? '').toLowerCase().includes(q);
  });

  const write = async () => {
    const payload: Record<string, number> = {};
    for (const c of changes) payload[c.key] = c.after;
    const r = await onWrite(payload, { password, save, risk: needsRisk ? risk : true });
    if (r?.ok) { setDraft({}); setConfirm(false); setChecked(false); }
  };

  return (
    <div className="settings">
      <div className="tools">
        <input className="search" placeholder="поиск: перенапряжение, банка, балансировка, SOC…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="group-chips">
          {groups.map((g) => (
            <Chip key={g} on={filter === g} onClick={() => setFilter(filter === g ? '' : g)} title={`показать группу «${g}»`}>{g}</Chip>
          )).slice(0, 14)}
        </div>
        <Chip on={onlyDirty} onClick={() => setOnlyDirty(!onlyDirty)}>только изменённые{changes.length ? ` · ${changes.length}` : ''}</Chip>
        <span className="sp" />
        <Btn onClick={() => setConfirm(true)} disabled={!changes.length || invalid || busy === 'write'} tone="primary"
          title={changes.length ? 'Показать список «было → станет» и записать' : 'Измените хотя бы одно поле'}>
          {busy === 'write' ? 'Пишу в плату…' : `Записать ${changes.length || ''}`.trim()}
        </Btn>
      </div>
      {invalid && <p className="warn-line">Есть значения вне допустимых пределов или шага — запись заблокирована.</p>}
      <table className="grid-table settings-table">
        <thead>
          <tr><th>параметр</th><th className="n">значение</th><th className="n">в плате</th><th>группа и пределы</th></tr>
        </thead>
        <tbody>
          {shown.map((it) => {
            const raw = draft[it.key];
            const dirty = raw !== undefined && Number(raw) !== Number(it.value);
            return (
              <tr key={it.key} className={`${it.error ? 'is-err' : ''} ${dirty ? 'is-dirty' : ''}`}>
                <td>
                  <span className="lab">{it.label}</span>
                  {it.risky && <span className="tagm risk" title="неверное значение может отключить защиту — нужна отдельная галочка">риск</span>}
                  {it.bits && (
                    <span className="bitrowset">
                      {it.bits.map((bit) => {
                        const value = Number(raw ?? it.value ?? 0);
                        const on = Boolean(value & bit.mask);
                        return (
                          <Chip key={bit.mask} on={on} title={bit.label}
                            onClick={() => setDraft({ ...draft, [it.key]: String(on ? value & ~bit.mask : value | bit.mask) })}>{bit.label}</Chip>
                        );
                      })}
                    </span>
                  )}
                  {it.error && <span className="muted small"> · {it.error}</span>}
                </td>
                <td className="n">
                  {it.editable ? (
                    <NumField
                      value={String(raw ?? (it.value ?? ''))}
                      onInput={(v) => setDraft({ ...draft, [it.key]: v })}
                      min={it.min} max={it.max} step={it.step} unit={it.unit} dirty={dirty}
                    />
                  ) : (
                    <span className="ro mono">{typeof it.value === 'number' ? num(it.value, decimals(it)) : (it.value ?? '—')} <i>{it.unit}</i></span>
                  )}
                </td>
                <td className="n mono muted">{typeof it.value === 'number' ? num(it.value, decimals(it)) : (it.value ?? '—')}</td>
                <td className="small muted">{it.group}{it.min != null && it.max != null ? ` · ${it.min}…${it.max}` : ''}{it.step ? ` · шаг ${it.step}` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {confirm && (
        <div className="veil" onClick={() => setConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Запись {changes.length} параметров в {bankTitle(registers)}</h3>
            <p className="muted small">Порядок: пароль → заводской режим → запись → выход {save ? 'с сохранением в память платы' : 'без сохранения (до выключения питания)'}. Каждое значение будет перечитано и сверено.</p>
            <div className="diff">
              {changes.map((c) => (
                <div key={c.key} className={`diff-row ${c.item.risky ? 'risk' : ''}`}>
                  <span className="lab">{c.label}</span>
                  <span className="was">{fmtBefore(c.before)}</span>
                  <span className="arrow">→</span>
                  <b>{c.after}{c.unit ? ` ${c.unit}` : ''}</b>
                  {c.item.risky && <span className="tagm risk">риск</span>}
                </div>
              ))}
            </div>
            <div className="modal-tools">
              <label className="fld"><span>пароль платы</span><input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="6 символов, если задан" maxLength={6} /></label>
              <label className="chk"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> сохранить в память платы</label>
              {needsRisk && <label className="chk risk"><input type="checkbox" checked={risk} onChange={(e) => setRisk(e.target.checked)} /> понимаю риск: маски, аппаратные защиты, таблица SOC</label>}
              <label className="chk"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> я сверил(а) значения с паспортом аккумулятора</label>
            </div>
            <div className="modal-actions">
              <Btn onClick={() => setConfirm(false)}>Отмена</Btn>
              <Btn tone="primary" onClick={write} disabled={!checked || (needsRisk && !risk) || busy === 'write'}>{busy === 'write' ? 'Пишу…' : 'Записать'}</Btn>
            </div>
          </div>
        </div>
      )}
      <p className="muted tiny note">
        Число банок, пароли, калибровку напряжений/токов и прошивку приложение не меняет — для них нужна эталонная аппаратура.
      </p>
    </div>
  );
}

function decimals(it: SettingItem) {
  if (it.unit === '°C') return 1;
  if (typeof it.value === 'string') return 0;
  return it.unit === 'В' ? 2 : 0;
}

const fmtBefore = (v: number | string | null) => (typeof v === 'number' ? String(v) : (v ?? '—'));

function bankTitle(r: BankRegisters) {
  return r.label ? `банк «${r.label}» (${r.port})` : `порт ${r.port}`;
}

const pad = (x: number) => String(x).padStart(2, '0');

const SHORT_WORDS: Record<string, string> = {
  'короткое замыкание': 'КЗ', 'перенапряжение': 'Перенапр.', 'понижение': 'Пониж.',
  'переохлаждение': 'Переохл.', 'перегрев': 'Перегрев', 'перегрузка': 'Перегрузка',
};
const short = (text: string) => {
  let out = text.toLowerCase();
  for (const [from, to] of Object.entries(SHORT_WORDS)) out = out.replace(from, to);
  out = out.replace(/ ячейки| батареи| при заряде| при разряде| по заряду| по разряду| заряда| разряда/g, '');
  return out.slice(0, 13);
};

function textOrDash(v: unknown) {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  return <span className="mono">{String(v)}</span>;
}
