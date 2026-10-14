// Плитка управления: команды платы (ключи заряда/разряда, балансировка банок,
// остаток ёмкости, сбросы, резервные копии) и журнал событий.
import { useState } from 'react';
import { Armed, Btn, Chip, ConfirmButton } from './Tile';
import type { BankRow, Catalog } from '../types';

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
          title="Включить или выключить силовой ключ заряда (действует до перезагрузки платы)"
          onConfirm={(next) => apply('fet', { charge: next, discharge: Boolean(bank?.dischargeFetOn) })}
        />
        <ConfirmButton
          on={Boolean(bank?.dischargeFetOn)} labelOn="разряд включён" labelOff="разряд выключен"
          disabled={disabled} busy={busy === 'fet'} tone="danger"
          title="Выключенный разряд отключает нагрузку от аккумулятора"
          onConfirm={(next) => apply('fet', { charge: Boolean(bank?.chargeFetOn), discharge: next })}
        />
        <Armed
          label={`Балансировка: ${balOn ? 'разрешена' : 'запрещена'}`} confirmLabel={balOn ? 'Запретить балансировку' : 'Разрешить балансировку'}
          onClick={() => { setBalOn(!balOn); apply('balance', { on: !balOn }); }}
          disabled={disabled} busy={busy === 'balance'} tone="ok"
          title="Разрешить или временно остановить выравнивание банок"
        />
        <Armed
          label="Сбросить счётчики защит" confirmLabel="Подтвердите сброс счётчиков"
          onClick={() => apply('clear-errors')}
          disabled={disabled} busy={busy === 'clear-errors'}
          title="Обнуляет счётчики срабатываний защит с сохранением в память платы"
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
        <Btn onClick={onBackup} disabled={disabled} title="сохранить все настройки в JSON">Копия настроек</Btn>
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
