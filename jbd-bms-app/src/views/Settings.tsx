// Настройки платы: пороги защит, ёмкость, токи. Значения читаются из памяти BMS.
// Изменить можно только параметры из списка записываемых; перед записью показывается
// перечень «было → станет», и запись требует явного подтверждения.
import { useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { SettingItem, SettingsResponse, WriteResponse } from '../types';
import { Empty } from './Overview';

type Draft = Record<string, string>;
interface Change { item: SettingItem; from: number; to: number }

export function Settings({ connected, initialData = null }: {
  connected: boolean;
  /** для тестов рендера: уже прочитанные настройки */
  initialData?: SettingsResponse | null;
}) {
  const [data, setData] = useState<SettingsResponse | null>(initialData);
  const [draft, setDraft] = useState<Draft>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<WriteResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      setData(await api<SettingsResponse>('/api/settings', {}, 60_000));
      setDraft({});
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  const itemByKey = useMemo(() => {
    const m: Record<string, SettingItem> = {};
    data?.items.forEach((it) => { m[it.key] = it; });
    return m;
  }, [data]);

  // ошибки ввода (клиентская проверка; сервер проверит ещё раз)
  const inputErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    for (const [key, text] of Object.entries(draft)) {
      const it = itemByKey[key];
      if (!it) continue;
      const v = parseNum(text);
      if (v === null) { errs[key] = 'введите число'; continue; }
      if (it.min !== undefined && v < it.min) { errs[key] = `не меньше ${it.min}`; continue; }
      if (it.max !== undefined && v > it.max) { errs[key] = `не больше ${it.max}`; continue; }
      if (it.step) {
        const k = Math.round(v / it.step);
        if (Math.abs(v - k * it.step) > 1e-9) errs[key] = `шаг ${it.step} ${it.unit}`;
      }
    }
    return errs;
  }, [draft, itemByKey]);

  const changes: Change[] = useMemo(() => {
    if (!data) return [];
    const out: Change[] = [];
    for (const [key, text] of Object.entries(draft)) {
      const it = itemByKey[key];
      const v = parseNum(text);
      if (!it || it.value === null || v === null) continue;
      if (v !== it.value) out.push({ item: it, from: it.value, to: v });
    }
    return out;
  }, [data, draft, itemByKey]);

  const hasErrors = Object.keys(inputErrors).length > 0;

  if (!connected) return <Empty title="Плата не подключена">Настройки читаются и записываются только при подключённой плате.</Empty>;

  const groups = groupItems(data?.items ?? []);

  return (
    <div className="grid settings">
      <section className="card wide">
        <div className="row-h">
          <div>
            <h3>Настройки платы</h3>
            <p className="muted small">
              Значения из памяти BMS. Изменяйте только то, что понимаете: неверные пороги могут отключить защиту
              аккумулятора или вызывать ложные срабатывания. Сверяйтесь с документацией производителя батареи и платы.
            </p>
          </div>
          <div className="set-actions">
            {changes.length > 0 && (
              <button className="btn" onClick={() => setDraft({})} disabled={confirmOpen}>Сбросить правки</button>
            )}
            <button className="btn" onClick={load} disabled={loading}>
              {loading ? 'Читаю…' : data ? 'Перечитать' : 'Прочитать настройки'}
            </button>
            <button
              className="btn primary"
              onClick={() => { setResult(null); setConfirmOpen(true); }}
              disabled={!data || changes.length === 0 || hasErrors}
              title={hasErrors ? 'Исправьте значения, отмеченные красным' : changes.length === 0 ? 'Сначала измените значения' : ''}
            >
              Записать в плату{changes.length ? ` (${changes.length})` : ''}…
            </button>
          </div>
        </div>

        {err && <div className="banner err inline">{err}</div>}
        {result && <WriteResult result={result} />}

        {!data && !loading && (
          <p className="muted">Нажмите «Прочитать настройки». Чтение занимает несколько секунд.</p>
        )}

        {data && groups.map((g) => (
          <div key={g.name} className="set-group">
            <h4>{g.name}</h4>
            <table className="table set-table">
              <thead>
                <tr>
                  <th>Параметр</th>
                  <th className="num">Сейчас в плате</th>
                  <th className="num">Новое значение</th>
                  <th className="num">Пределы</th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((it) => {
                  const changed = draft[it.key] !== undefined && changes.some((c) => c.item.key === it.key);
                  const error = inputErrors[it.key];
                  return (
                    <tr key={it.key} className={changed ? 'set-changed' : ''} title={it.error ?? ''}>
                      <td>
                        {it.label}
                        {!it.editable && <span className="muted small"> · только чтение</span>}
                      </td>
                      <td className="num">
                        {it.value === null
                          ? <span className="muted">нет данных</span>
                          : <>{formatValue(it.value)} <span className="muted">{it.unit}</span>{humanHint(it) && <div className="muted tiny">{humanHint(it)}</div>}</>}
                      </td>
                      <td className="num">
                        {it.editable && it.value !== null ? (
                          <div className="set-input">
                            <input
                              type="text"
                              inputMode="decimal"
                              className={`set-num ${error ? 'bad' : ''}`}
                              value={draft[it.key] ?? formatInput(it.value)}
                              onChange={(e) => setDraft((d) => ({ ...d, [it.key]: e.target.value }))}
                              aria-label={it.label}
                            />
                            <span className="muted">{it.unit}</span>
                            {error && <div className="set-err tiny">{error}</div>}
                          </div>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className="num muted small">
                        {it.editable && it.min !== undefined && it.max !== undefined
                          ? `${it.min} … ${it.max} ${it.unit}`
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {confirmOpen && data && (
        <ConfirmWrite
          changes={changes}
          onCancel={() => setConfirmOpen(false)}
          onDone={async (r) => {
            setConfirmOpen(false);
            setResult(r);
            await load();
          }}
        />
      )}
    </div>
  );
}

function WriteResult({ result }: { result: WriteResponse }) {
  const bad = result.items.filter((i) => !i.ok);
  return (
    <div className={`banner ${result.ok ? 'ok' : 'err'} inline`}>
      <b>{result.message}</b>
      {result.items.length > 0 && (
        <table className="table set-table mt">
          <thead>
            <tr><th>Параметр</th><th className="num">Было</th><th className="num">Записано</th><th className="num">Проверка чтением</th></tr>
          </thead>
          <tbody>
            {result.items.map((i) => (
              <tr key={i.key}>
                <td>{i.label}</td>
                <td className="num">{i.before === null ? '—' : formatValue(i.before)} {i.unit}</td>
                <td className="num">{formatValue(i.requested)} {i.unit}</td>
                <td className="num">
                  {i.ok ? <span className="ok">совпало</span> : <span className="bad">{i.actual === null ? 'не прочитано' : `${formatValue(i.actual)} ${i.unit}`}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {bad.length > 0 && <p className="small">Перечитайте настройки: часть значений в плате отличается от введённых.</p>}
    </div>
  );
}

function ConfirmWrite({ changes, onCancel, onDone }: {
  changes: Change[];
  onCancel: () => void;
  onDone: (r: WriteResponse) => void | Promise<void>;
}) {
  const [save, setSave] = useState(true);
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const passwordOk = password === '' || password.length === 6;
  const canWrite = understood && passwordOk && !busy && changes.length > 0;

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const body = {
        confirm: true,
        save,
        password,
        changes: Object.fromEntries(changes.map((c) => [c.item.key, c.to])),
      };
      const r = await api<WriteResponse>('/api/settings/write', { method: 'POST', body: JSON.stringify(body) }, 60_000);
      await onDone(r);
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : String(e?.message ?? e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="modal set-modal" role="dialog" aria-modal="true" aria-labelledby="set-title">
        <h3 id="set-title">Записать настройки в плату</h3>
        <p className="small">
          Новые значения уйдут в BMS. Плата проверит и сохранит их, затем приложение перечитает каждое значение.
          Изменения затрагивают защиту аккумулятора: убедитесь, что значения верны.
        </p>
        <table className="table set-table">
          <thead><tr><th>Параметр</th><th className="num">Было</th><th className="num">Станет</th></tr></thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.item.key}>
                <td>{c.item.label}</td>
                <td className="num">{formatValue(c.from)} {c.item.unit}</td>
                <td className="num"><b>{formatValue(c.to)} {c.item.unit}</b></td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="set-options">
          <label className="chk">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
            <span>Сохранить в память платы. Без этого значения сбросятся после выключения платы.</span>
          </label>
          <label className="set-pass">
            <span className="small">Пароль платы (6 символов, если задан; пусто — пароль не задан)</span>
            <input
              type="password"
              maxLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              className={`set-num ${passwordOk ? '' : 'bad'}`}
            />
            {!passwordOk && <span className="set-err tiny">нужно ровно 6 символов или пусто</span>}
          </label>
          <label className="chk">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>Я проверил(а) значения. Понимаю, что неверные пороги могут отключить защиту аккумулятора.</span>
          </label>
        </div>

        {err && <div className="banner err inline">{err}</div>}
        <div className="set-modal-foot">
          <button className="btn" onClick={onCancel} disabled={busy}>Отмена</button>
          <button className="btn primary" onClick={submit} disabled={!canWrite}>
            {busy ? 'Записываю…' : `Записать ${changes.length} ${plural(changes.length)}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- helpers ----------

function groupItems(items: SettingItem[]): { name: string; items: SettingItem[] }[] {
  const order: string[] = [];
  const map: Record<string, SettingItem[]> = {};
  for (const it of items) {
    const name = it.group ?? 'Прочее';
    if (!map[name]) { map[name] = []; order.push(name); }
    map[name].push(it);
  }
  return order.map((name) => ({ name, items: map[name] }));
}

/** Число из текста: допускаем запятую как десятичный разделитель. */
function parseNum(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '' || t === '-' || t === '.') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function formatInput(v: number): string {
  return String(v).replace('.', ',');
}

/** Человекочитаемый пересчёт: мВ → В, мА → А, мАч → Ач. */
function humanHint(it: SettingItem): string {
  if (it.value === null) return '';
  if (it.unit === 'мВ') return `${(it.value / 1000).toFixed(3).replace('.', ',')} В`;
  if (it.unit === 'мА') return `${(it.value / 1000).toFixed(1).replace('.', ',')} А`;
  if (it.unit === 'мАч') return `${(it.value / 1000).toFixed(1).replace('.', ',')} Ач`;
  return '';
}

function plural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'параметр';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'параметра';
  return 'параметров';
}
