// Прошивка: текущая версия с платы, проверка файла .hex и (пока заблокированная) запись.
import { useRef, useState } from 'react';
import { api, fmtBytes } from '../api';
import type { FirmwareInfo } from '../types';
import { Icon } from '../icons';

export function Firmware({ connected, version = '—', deviceName = '', cellCount = null, onStateChange, initialInfo = null }: {
  connected: boolean;
  /** версия прошивки из регистра 0x03 (или «—») */
  version?: string | null;
  deviceName?: string;
  cellCount?: number | null;
  onStateChange: () => void;
  /** для тестов рендера: результат проверки файла без загрузки */
  initialInfo?: FirmwareInfo | null;
}) {
  const [info, setInfo] = useState<FirmwareInfo | null>(initialInfo);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [flashMsg, setFlashMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setErr('');
    setFlashMsg('');
    try {
      const text = await file.text();
      const r = await api<FirmwareInfo>('/api/firmware/inspect', {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', 'x-file-name': encodeURIComponent(file.name) },
        body: text,
      }, 30_000);
      setInfo(r);
      onStateChange();
    } catch (e: any) {
      setErr(e.message);
      setInfo(null);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const flash = async () => {
    setFlashMsg('');
    try {
      await api('/api/firmware/flash', { method: 'POST', body: '{}' }, 30_000);
      setFlashMsg('Прошивка записана.');
    } catch (e: any) {
      setFlashMsg(e.message);
    }
  };

  return (
    <div className="grid firmware">
      <section className="card">
        <h3>Текущая прошивка</h3>
        {!connected && <p className="muted small">Подключите BMS, чтобы увидеть версию.</p>}
        <ul className="kv">
          <li><span>Версия (регистр 0x03)</span><b>{connected ? (version || '—') : '—'}</b></li>
          <li><span>Имя устройства</span><b>{deviceName || '—'}</b></li>
          <li><span>Ячеек</span><b>{cellCount ?? '—'}</b></li>
        </ul>
      </section>

      <section className="card">
        <h3>Файл прошивки (.hex)</h3>
        <p className="muted small">
          Формат Intel HEX — как у прошивок JBD для JBDTools. Файл проверяется построчно:
          контрольные суммы, адреса, конец файла. Плата на этом шаге не меняется.
        </p>
        <div className="row-h gap">
          <input ref={fileRef} type="file" accept=".hex,.ihx,.txt" id="fw-file" className="visually-hidden"
            onChange={(e) => onPick(e.target.files?.[0])} />
          <label htmlFor="fw-file" className={`btn ${busy ? 'disabled' : ''}`} aria-disabled={busy}>
            <Icon name="download" /> Выбрать файл…
          </label>
          {busy && <span className="muted small">Проверяю…</span>}
        </div>
        {err && <div className="banner err inline">{err}</div>}
      </section>

      {info && (
        <section className="card wide">
          <h3 className="row-h">
            {info.fileName}
            <span className={`chip-state ${info.ok ? 'ok' : 'bad'}`}>
              <Icon name={info.ok ? 'check' : 'alert'} size={13} />
              {info.ok ? 'файл корректен' : 'есть ошибки'}
            </span>
          </h3>
          <ul className="kv">
            <li><span>Размер данных</span><b>{info.sizeKiB} КБ ({fmtBytes(info.bytes)})</b></li>
            <li><span>Диапазон адресов</span>
              <b>{info.minAddress === null ? '—' : `0x${info.minAddress.toString(16).toUpperCase()} – 0x${(info.maxAddress ?? 0).toString(16).toUpperCase()}`}</b></li>
            <li><span>Участков памяти</span><b>{info.segments.length}</b></li>
            <li><span>Записей HEX</span><b>{info.records}</b></li>
            <li><span>SHA-256</span><b className="mono">{info.sha256 ?? '—'}</b></li>
          </ul>
          {info.errors.length > 0 && (
            <div className="banner err inline">
              <b>Ошибки файла:</b>
              <ul>{info.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          {info.warnings.length > 0 && (
            <p className="muted small">Замечания: {info.warnings.join('; ')}</p>
          )}
        </section>
      )}

      <section className="card wide">
        <h3>Запись прошивки в BMS</h3>
        <div className="banner warn inline">
          <Icon name="shield" />
          <div>
            <b>Запись отключена.</b> {info?.writeBlockedReason
              ?? 'Протокол загрузчика JBD не опубликован, а неверная запись выводит BMS из строя. '
                + 'Приложение не отправляет прошивку в плату, пока протокол не проверен на реальной плате.'}
          </div>
        </div>
        <div className="row-h gap mt">
          <button className="btn primary" disabled={!connected || !info?.canWrite} onClick={flash}>
            Записать прошивку
          </button>
          {flashMsg && <span className="muted small">{flashMsg}</span>}
        </div>
        <p className="muted small mt">
          Чтобы включить запись, нужен захват обмена JBDTools с платой (лог UART при обновлении).
          По нему реализуется загрузчик; до этого приложение только читает и проверяет файлы.
        </p>
      </section>
    </div>
  );
}
