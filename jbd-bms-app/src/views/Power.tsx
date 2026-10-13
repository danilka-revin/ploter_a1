// Главный блок страницы: наглядная схема «зарядник → ключ заряда → аккумулятор →
// ключ разряда → нагрузка» и две большие кнопки включения заряда и разряда.
// Каждое переключение сначала требует подтверждения крупной кнопкой «Да».
import { useState } from 'react';
import { api, ApiError } from '../api';
import type { Snapshot } from '../types';
import { Icon } from '../icons';

type Which = 'charge' | 'discharge';
interface Pending { which: Which; charge: boolean; discharge: boolean }
interface Msg { ok: boolean; text: string }

const CURRENT_EPS = 0.05; // А: меньше — считаем, что тока нет

export function PowerPanel({ snap, connected, port, demo }: {
  snap: Snapshot | null;
  connected: boolean;
  port: string | null;
  demo: boolean;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  const b = connected && snap ? snap.basic : null;
  const chargeOn = b ? b.chargeFetOn : null;
  const dischargeOn = b ? b.dischargeFetOn : null;

  const ask = (which: Which) => {
    if (!b) return;
    setMsg(null);
    setPending({
      which,
      charge: which === 'charge' ? !b.chargeFetOn : b.chargeFetOn,
      discharge: which === 'discharge' ? !b.dischargeFetOn : b.dischargeFetOn,
    });
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; message: string }>('/api/control/fet', {
        method: 'POST',
        body: JSON.stringify({ confirm: true, charge: pending.charge, discharge: pending.discharge }),
      }, 30_000);
      setMsg({ ok: r.ok, text: r.message });
    } catch (e: any) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : String(e?.message ?? e) });
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const cur = b?.packCurrent ?? 0;
  const sourceName = demo ? 'демо-батарея' : port ?? '';

  return (
    <section className="card power-card" aria-labelledby="power-title">
      <div className="sec-head">
        <h2 id="power-title">2. Заряд и разряд</h2>
        <span className="muted small">{connected ? (demo ? 'демо-режим' : `плата на ${sourceName}`) : 'плата не подключена'}</span>
      </div>

      <Schematic snap={snap} connected={connected} portName={sourceName} />

      <div className="power-buttons">
        <PowerButton
          title="ЗАРЯД"
          sub="батарею заряжает зарядник"
          on={chargeOn}
          disabled={!b || busy}
          onClick={() => ask('charge')}
        />
        <PowerButton
          title="РАЗРЯД"
          sub="батарея отдаёт ток в нагрузку"
          on={dischargeOn}
          disabled={!b || busy}
          onClick={() => ask('discharge')}
        />
      </div>

      {!connected && (
        <p className="power-hint">Чтобы включать и выключать заряд и разряд, сначала подключите плату (блок 1).</p>
      )}
      {connected && b && (
        <p className="power-hint">
          {cur > CURRENT_EPS ? 'Сейчас батарея заряжается.' : cur < -CURRENT_EPS ? 'Сейчас батарея отдаёт ток в нагрузку.' : 'Сейчас ток почти не идёт.'}
          {' '}Переключение записывается в плату до её выключения (в память не сохраняется).
        </p>
      )}

      {pending && (
        <div className="power-confirm" role="alertdialog" aria-live="assertive">
          <div className="pc-title">{confirmTitle(pending)}</div>
          <div className="pc-text">{confirmText(pending)}</div>
          <div className="pc-actions">
            <button className="big-btn" onClick={() => setPending(null)} disabled={busy}>Нет, отмена</button>
            <button className="big-btn primary" onClick={confirm} disabled={busy}>
              {busy ? 'Выполняю…' : 'Да, подтверждаю'}
            </button>
          </div>
        </div>
      )}

      {msg && <div className={`banner ${msg.ok ? 'ok' : 'err'} inline`}>{msg.text}</div>}
    </section>
  );
}

function confirmTitle(p: Pending): string {
  const name = p.which === 'charge' ? 'заряд' : 'разряд';
  const on = p.which === 'charge' ? p.charge : p.discharge;
  return `${on ? 'Включить' : 'Выключить'} ${name}?`;
}

function confirmText(p: Pending): string {
  if (p.which === 'charge') {
    return p.charge
      ? 'Батарея снова сможет заряжаться от зарядного устройства.'
      : 'Зарядка батареи остановится. Нагрузка будет питаться только от батареи.';
  }
  return p.discharge
    ? 'Батарея снова сможет отдавать ток в нагрузку.'
    : 'Батарея перестанет отдавать ток: нагрузка отключится от батареи.';
}

function PowerButton({ title, sub, on, disabled, onClick }: {
  title: string; sub: string; on: boolean | null; disabled: boolean; onClick: () => void;
}) {
  const state = on === null ? 'нет данных' : on ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
  const action = on === null ? '' : on ? 'Нажмите, чтобы ВЫКЛЮЧИТЬ' : 'Нажмите, чтобы ВКЛЮЧИТЬ';
  const cls = on === null ? 'is-unknown' : on ? 'is-on' : 'is-off';
  return (
    <button className={`power-btn ${cls}`} onClick={onClick} disabled={disabled} aria-pressed={on === true}>
      <span className="pb-ico"><Icon name="power" size={34} /></span>
      <span className="pb-main">
        <span className="pb-title">{title}</span>
        <span className="pb-state">{state}</span>
        <span className="pb-sub">{sub}</span>
        {action && <span className="pb-action">{action}</span>}
      </span>
    </button>
  );
}

/** Схема: зарядник, два ключа (Q1 — заряд, Q2 — разряд), аккумулятор, плата BMS и порт компьютера. */
function Schematic({ snap, connected, portName }: { snap: Snapshot | null; connected: boolean; portName: string }) {
  const b = connected && snap ? snap.basic : null;
  const cOn = b ? b.chargeFetOn : null;
  const dOn = b ? b.dischargeFetOn : null;
  const cur = b?.packCurrent ?? 0;
  const cells = snap ? snap.cells.values.length || snap.basic.cellCount : 0;
  const balancing = new Set(b?.balancingCells ?? []);

  const colorOf = (on: boolean | null) => (on === null ? 'var(--line)' : on ? 'var(--ok)' : 'var(--danger)');
  const flowCharge = cOn === true && cur > CURRENT_EPS;
  const flowDischarge = dOn === true && cur < -CURRENT_EPS;

  // ячейки внутри аккумулятора: одна полоска на каждую ячейку
  const innerX = 402;
  const innerW = 156;
  const gap = 3;
  const n = Math.max(cells, 1);
  const cw = (innerW - gap * (n - 1)) / n;

  const label = `Схема: зарядник — ключ заряда ${stateWord(cOn)} — аккумулятор — ключ разряда ${stateWord(dOn)} — нагрузка. Плата BMS подключена к порту ${portName || 'не выбран'}.`;

  return (
    <div className="schema-wrap">
      <svg viewBox="0 0 960 350" className="schema" role="img" aria-label={label}>
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
          </marker>
        </defs>

        {/* зарядник */}
        <rect x="26" y="108" width="176" height="124" rx="16" className="sc-box" />
        <text x="114" y="150" className="sc-title" textAnchor="middle">ЗАРЯДНИК</text>
        <text x="114" y="172" className="sc-sub" textAnchor="middle">зарядное устройство</text>
        <text x="114" y="200" className="sc-sym" textAnchor="middle">+  −</text>

        {/* провод от зарядника к ключу заряда */}
        <line x1="202" y1="170" x2="252" y2="170" className="sc-wire" style={{ stroke: colorOf(cOn) }} />
        {flowCharge && <line x1="202" y1="170" x2="252" y2="170" className="sc-flow" />}

        {/* ключ заряда Q1 */}
        <text x="290" y="128" className="sc-label" textAnchor="middle">ключ заряда</text>
        <rect x="252" y="146" width="76" height="48" rx="10" className="sc-switch" style={{ stroke: colorOf(cOn) }} />
        <text x="290" y="168" className="sc-q" textAnchor="middle">Q1</text>
        <text x="290" y="184" className="sc-state" textAnchor="middle" style={{ fill: colorOf(cOn) }}>{stateWord(cOn)}</text>

        {/* провод к аккумулятору */}
        <line x1="328" y1="170" x2="380" y2="170" className="sc-wire" style={{ stroke: colorOf(cOn) }} />
        {flowCharge && <line x1="328" y1="170" x2="380" y2="170" className="sc-flow" />}

        {/* аккумулятор */}
        <rect x="380" y="92" width="200" height="158" rx="14" className="sc-box sc-pack" />
        <rect x="580" y="136" width="8" height="26" rx="2" className="sc-nub" />
        <text x="480" y="118" className="sc-title" textAnchor="middle">АККУМУЛЯТОР</text>
        <text x="480" y="150" className="sc-big" textAnchor="middle">
          {b ? `${b.packVoltage.toFixed(2)} В` : '— В'}
        </text>
        <text x="480" y="170" className="sc-sub" textAnchor="middle">
          {b ? `${b.capacityPct}% · ${cells} ячеек` : `${cells || '—'} ячеек`}
        </text>
        {/* ячейки */}
        {Array.from({ length: n }, (_, i) => (
          <rect
            key={i}
            x={innerX + i * (cw + gap)}
            y="186"
            width={cw}
            height="34"
            rx="2"
            className={`sc-cell ${balancing.has(i + 1) ? 'is-bal' : ''}`}
          />
        ))}

        {/* провод к ключу разряда */}
        <line x1="580" y1="170" x2="630" y2="170" className="sc-wire" style={{ stroke: colorOf(dOn) }} />
        {flowDischarge && <line x1="580" y1="170" x2="630" y2="170" className="sc-flow" />}

        {/* ключ разряда Q2 */}
        <text x="670" y="128" className="sc-label" textAnchor="middle">ключ разряда</text>
        <rect x="630" y="146" width="76" height="48" rx="10" className="sc-switch" style={{ stroke: colorOf(dOn) }} />
        <text x="670" y="168" className="sc-q" textAnchor="middle">Q2</text>
        <text x="670" y="184" className="sc-state" textAnchor="middle" style={{ fill: colorOf(dOn) }}>{stateWord(dOn)}</text>

        {/* провод к нагрузке */}
        <line x1="706" y1="170" x2="758" y2="170" className="sc-wire" style={{ stroke: colorOf(dOn) }} />
        {flowDischarge && <line x1="706" y1="170" x2="758" y2="170" className="sc-flow" />}

        {/* нагрузка */}
        <rect x="758" y="108" width="176" height="124" rx="16" className="sc-box" />
        <text x="846" y="150" className="sc-title" textAnchor="middle">НАГРУЗКА</text>
        <text x="846" y="172" className="sc-sub" textAnchor="middle">потребители</text>
        <text x="846" y="200" className="sc-sym" textAnchor="middle">+  −</text>

        {/* управление ключами от платы BMS */}
        <path d="M380 282 H290 V196" className="sc-ctrl" />
        <path d="M580 282 H670 V196" className="sc-ctrl" />
        <text x="335" y="270" className="sc-small" textAnchor="middle">управляет ключами</text>

        {/* плата BMS */}
        <rect x="380" y="270" width="200" height="60" rx="10" className="sc-box sc-bms" />
        <text x="480" y="296" className="sc-title" textAnchor="middle">ПЛАТА BMS</text>
        <text x="480" y="316" className="sc-sub" textAnchor="middle">защита и контроль ячеек</text>
        <line x1="480" y1="250" x2="480" y2="270" className="sc-ctrl" />

        {/* связь с компьютером через адаптер */}
        <rect x="26" y="262" width="236" height="76" rx="14" className="sc-box" />
        <text x="144" y="290" className="sc-title" textAnchor="middle">КОМПЬЮТЕР</text>
        <text x="144" y="314" className="sc-port" textAnchor="middle">{portName ? `порт ${portName}` : 'порт не выбран'}</text>
        <line x1="262" y1="300" x2="380" y2="300" className="sc-uart" />
        <text x="321" y="322" className="sc-small" textAnchor="middle">UART 9600</text>
      </svg>
    </div>
  );
}

function stateWord(on: boolean | null): string {
  return on === null ? '—' : on ? 'ВКЛ' : 'ВЫКЛ';
}
