// Управление платой: ключи заряда/разряда, остаток ёмкости, счётчики ошибок,
// резервная копия настроек. Каждое действие требует подтверждения.
import { useState } from 'react';
import { api, ApiError } from '../api';
import type { Snapshot, WriteResponse } from '../types';
import { Empty } from './Overview';

const ERROR_LABELS: Record<string, string> = {
  sc: 'Короткое замыкание', chgoc: 'Перегрузка заряда', dsgoc: 'Перегрузка разряда',
  covp: 'Перенапряжение ячейки', cuvp: 'Понижение ячейки', chgot: 'Перегрев заряда',
  chgut: 'Переохлаждение заряда', dsgot: 'Перегрев разряда', dsgut: 'Переохлаждение разряда',
  povp: 'Перенапряжение батареи', puvp: 'Понижение батареи',
};

interface Pending { id: string; title: string; text: string; run: () => Promise<void> }
interface Msg { ok: boolean; text: string }

export function Control({ snap, connected }: { snap: Snapshot | null; connected: boolean }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Record<string, Msg>>({});
  const [ah, setAh] = useState('');

  if (!connected) return <Empty title="Плата не подключена">Управление доступно только при подключённой плате.</Empty>;
  if (!snap) return <Empty title="Читаю состояние…">Запрос к BMS…</Empty>;

  const b = snap.basic;

  const runAction = async (p: Pending) => {
    setBusy(true);
    try {
      await p.run();
    } catch (e: any) {
      setMsg((m) => ({ ...m, [p.id]: { ok: false, text: e instanceof ApiError ? e.message : String(e?.message ?? e) } }));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const setFet = (charge: boolean, discharge: boolean, id: string, title: string, text: string) =>
    setPending({
      id, title, text,
      run: async () => {
        const r = await api<{ ok: boolean; message: string }>('/api/control/fet', {
          method: 'POST', body: JSON.stringify({ confirm: true, charge, discharge }),
        }, 30_000);
        setMsg((m) => ({ ...m, [id]: { ok: r.ok, text: r.message } }));
      },
    });

  const fetLabel = (on: boolean) => (on ? 'включён' : 'выключен');

  return (
    <div className="ctl-grid">
      <section className="card ctl-card">
        <h3>Ключи заряда и разряда</h3>
        <div className="ctl-state">
          <span className={`ctl-pill ${b.chargeFetOn ? 'on' : 'off'}`}>Заряд: {fetLabel(b.chargeFetOn)}</span>
          <span className={`ctl-pill ${b.dischargeFetOn ? 'on' : 'off'}`}>Разряд: {fetLabel(b.dischargeFetOn)}</span>
        </div>
        <div className="ctl-row">
          <button className="btn" disabled={busy} onClick={() => setFet(!b.chargeFetOn, b.dischargeFetOn, 'fet', b.chargeFetOn ? 'Выключить заряд' : 'Включить заряд',
            b.chargeFetOn ? 'Зарядка батареи остановится. Нагрузка будет питаться от батареи.' : 'Зарядка батареи разрешится.')}>
            {b.chargeFetOn ? 'Выключить заряд' : 'Включить заряд'}
          </button>
          <button className="btn" disabled={busy} onClick={() => setFet(b.chargeFetOn, !b.dischargeFetOn, 'fet', b.dischargeFetOn ? 'Выключить разряд' : 'Включить разряд',
            b.dischargeFetOn ? 'Батарея перестанет отдавать ток. Нагрузка отключится от батареи.' : 'Разряд батареи разрешится.')}>
            {b.dischargeFetOn ? 'Выключить разряд' : 'Включить разряд'}
          </button>
        </div>
        <p className="muted small">Не сохраняется в память платы: после выключения платы ключи снова включаются.</p>
        <Confirm pending={pending} id="fet" busy={busy} onCancel={() => setPending(null)} onRun={runAction} />
        <Result m={msg.fet} />
      </section>

      <section className="card ctl-card">
        <h3>Остаток ёмкости</h3>
        <div className="ctl-state small muted">
          Сейчас: <b>{b.remainingAh.toFixed(1)} Ач</b> из {b.fullAh.toFixed(1)} Ач ({b.capacityPct}%)
        </div>
        <div className="ctl-row">
          <input
            className="set-num"
            inputMode="decimal"
            placeholder={b.remainingAh.toFixed(1).replace('.', ',')}
            value={ah}
            onChange={(e) => setAh(e.target.value)}
            aria-label="Остаток, Ач"
          />
          <span className="muted">Ач</span>
          <button
            className="btn"
            disabled={busy || parseAh(ah) === null}
            onClick={() => {
              const v = parseAh(ah);
              if (v === null) return;
              setPending({
                id: 'cap', title: 'Установить остаток ёмкости', text: `Остаток станет ${v.toFixed(1)} Ач. Оценка заряда (SOC) будет пересчитываться от этого значения.`,
                run: async () => {
                  const r = await api<{ ok: boolean; remainingAh: number }>('/api/control/capacity', {
                    method: 'POST', body: JSON.stringify({ confirm: true, ah: v }),
                  }, 30_000);
                  setMsg((m) => ({ ...m, cap: { ok: r.ok, text: r.ok ? `Остаток установлен: ${r.remainingAh.toFixed(1)} Ач.` : `Плата показала ${r.remainingAh.toFixed(2)} Ач вместо ${v}.` } }));
                  setAh('');
                },
              });
            }}
          >Установить…</button>
        </div>
        <p className="muted small">Используйте после полной зарядки или разрядки, когда остаток известен точно.</p>
        <Confirm pending={pending} id="cap" busy={busy} onCancel={() => setPending(null)} onRun={runAction} />
        <Result m={msg.cap} />
      </section>

      <section className="card ctl-card">
        <h3>Счётчики ошибок</h3>
        {snap.errors === null ? (
          <p className="muted small">Плата не отдаёт счётчики.</p>
        ) : (
          <ul className="ctl-list">
            {Object.entries(snap.errors).map(([k, v]) => (
              <li key={k} className={v > 0 ? 'warn' : ''}>{ERROR_LABELS[k] ?? k}: <b>{v}</b></li>
            ))}
          </ul>
        )}
        <div className="ctl-row">
          <button
            className="btn"
            disabled={busy || !snap.errors}
            onClick={() => setPending({
              id: 'errors', title: 'Сбросить счётчики ошибок', text: 'Все счётчики срабатываний защит будут обнулены и сохранены в память платы.',
              run: async () => {
                const r = await api<{ ok: boolean; message: string }>('/api/control/clear-errors', {
                  method: 'POST', body: JSON.stringify({ confirm: true }),
                }, 30_000);
                setMsg((m) => ({ ...m, errors: { ok: r.ok, text: r.message } }));
              },
            })}
          >Сбросить счётчики…</button>
        </div>
        <Confirm pending={pending} id="errors" busy={busy} onCancel={() => setPending(null)} onRun={runAction} />
        <Result m={msg.errors} />
      </section>

      <BackupCard busy={busy} />

      <section className="card ctl-card">
        <h3>Не делается в приложении</h3>
        <ul className="ctl-list">
          <li>Калибровка напряжения, токов и температур — нужны эталонные приборы; ошибка калибровки искажает все показания.</li>
          <li>Тест балансировки — подаёт команды на балансиры напрямую, может перегреть ячейки.</li>
          <li>Смена и сброс пароля платы — ошибка может закрыть доступ к плате.</li>
          <li>Число ячеек — от него зависят все пороги; задаётся при первичной настройке.</li>
          <li>Прошивка — нет подтверждённого протокола загрузки.</li>
        </ul>
      </section>
    </div>
  );
}

function BackupCard({ busy: outerBusy }: { busy: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [plan, setPlan] = useState<{ file: any; changes: { key: string; label: string; unit: string; from: number | null; to: number }[]; skipped: string[] } | null>(null);
  const [save, setSave] = useState(true);
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);

  const download = async () => {
    setErr(''); setOk(''); setBusy(true);
    try {
      const data = await api<any>('/api/backup', {}, 60_000);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jbd-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setOk('Копия сохранена в файл.');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (f: File) => {
    setErr(''); setOk(''); setPlan(null); setUnderstood(false);
    try {
      const file = JSON.parse(await f.text());
      const r = await api<any>('/api/backup/restore', { method: 'POST', body: JSON.stringify({ file, dryRun: true }) }, 60_000);
      setPlan({ file, changes: r.changes, skipped: r.skipped });
      if (r.changes.length === 0) setOk('Копия совпадает с платой — восстанавливать нечего.');
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось прочитать файл: ' + (e?.message ?? e));
    }
  };

  const restore = async () => {
    if (!plan) return;
    setErr(''); setOk(''); setBusy(true);
    try {
      const r = await api<WriteResponse>('/api/backup/restore', {
        method: 'POST',
        body: JSON.stringify({ file: plan.file, dryRun: false, confirm: true, save, password }),
      }, 60_000);
      setOk(r.message);
      setPlan(null);
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const passwordOk = password === '' || password.length === 6;

  return (
    <section className="card ctl-card">
      <h3>Резервная копия настроек</h3>
      <p className="muted small">Копия — файл JSON со всеми параметрами из раздела «Защиты и настройки». Восстановление покажет список изменений до записи.</p>
      <div className="ctl-row">
        <button className="btn" onClick={download} disabled={busy || outerBusy}>Сохранить копию</button>
        <label className="btn" style={{ cursor: 'pointer' }}>
          Восстановить из файла…
          <input type="file" accept="application/json,.json" hidden disabled={busy || outerBusy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = ''; }} />
        </label>
      </div>

      {plan && plan.changes.length > 0 && (
        <div className="ctl-confirm">
          <div><b>Будет записано {plan.changes.length}:</b></div>
          <table className="table cells-table ctl-diff">
            <thead><tr><th>Параметр</th><th className="num">Сейчас</th><th className="num">Из копии</th></tr></thead>
            <tbody>
              {plan.changes.map((c) => (
                <tr key={c.key}>
                  <td>{c.label}</td>
                  <td className="num">{c.from ?? '—'} {c.unit}</td>
                  <td className="num"><b>{c.to} {c.unit}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.skipped.length > 0 && <p className="muted small">Пропущено (нельзя записать из приложения): {plan.skipped.join(', ')}</p>}
          <label className="chk"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> <span>Сохранить в память платы</span></label>
          <label className="set-pass"><span className="small">Пароль платы (6 символов, если задан)</span>
            <input type="password" maxLength={6} className={`set-num ${passwordOk ? '' : 'bad'}`} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </label>
          <label className="chk"><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> <span>Я проверил(а) список. Понимаю, что пороги влияют на защиту батареи.</span></label>
          <div className="ctl-row">
            <button className="btn" onClick={() => setPlan(null)} disabled={busy}>Отмена</button>
            <button className="btn primary" onClick={restore} disabled={busy || !understood || !passwordOk}>
              {busy ? 'Записываю…' : 'Восстановить'}
            </button>
          </div>
        </div>
      )}
      {err && <div className="banner err inline">{err}</div>}
      {ok && <div className="banner ok inline">{ok}</div>}
    </section>
  );
}

function Confirm({ pending, id, busy, onCancel, onRun }: {
  pending: Pending | null; id: string; busy: boolean;
  onCancel: () => void; onRun: (p: Pending) => void;
}) {
  if (!pending || pending.id !== id) return null;
  return (
    <div className="ctl-confirm">
      <div><b>{pending.title}?</b></div>
      <div className="muted small">{pending.text}</div>
      <div className="ctl-row">
        <button className="btn" onClick={onCancel} disabled={busy}>Отмена</button>
        <button className="btn primary" onClick={() => onRun(pending)} disabled={busy}>{busy ? 'Выполняю…' : 'Подтвердить'}</button>
      </div>
    </div>
  );
}

function Result({ m }: { m?: Msg }) {
  if (!m) return null;
  return <div className={`banner ${m.ok ? 'ok' : 'err'} inline`}>{m.text}</div>;
}

function parseAh(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) && v >= 0 ? v : null;
}
