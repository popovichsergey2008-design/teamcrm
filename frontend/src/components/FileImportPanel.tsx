import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError, ImportPreview, ImportStats } from '../lib/api';
import type { Project } from '../types';

/**
 * Импорт задач из файла (CSV/Excel).
 *
 * Через таблицу переезжает что угодно: выгрузки Trello, Notion, Asana, Jira и любые
 * самописные списки. Ключей и согласий не требует — потому этот путь и сделан первым.
 *
 * Три шага, и средний — главный: файл → СОПОСТАВИТЬ КОЛОНКИ → импорт. Колонки мы
 * угадываем сами, но последнее слово за человеком: молча положить «Ответственный» в
 * описание значит потерять смысл всей выгрузки, а заметить это можно через неделю.
 */

export function FileImportPanel() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [fields, setFields] = useState<{ key: string; label: string; hint: string }[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [target, setTarget] = useState<{ mode: 'new' | 'existing'; projectId: string; name: string }>({
    mode: 'new', projectId: '', name: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<ImportStats | null>(null);

  useEffect(() => {
    api.listProjects().then(setProjects).catch(() => undefined);
    api.importFields().then(setFields).catch(() => undefined);
  }, []);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setErr(''); setResult(null); setBusy(true);
    try {
      const p = await api.importPreview(file);
      setPreview(p);
      setMapping(p.mapping as Record<string, number>);
      setTarget((t) => ({ ...t, name: file.name.replace(/\.[^.]+$/, '').slice(0, 100) }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Файл не прочитался');
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!preview) return;
    setErr(''); setBusy(true);
    try {
      const stats = await api.importRun({
        token: preview.token,
        mapping,
        projectId: target.mode === 'existing' ? target.projectId : undefined,
        newProjectName: target.mode === 'new' ? (target.name || undefined) : undefined,
      });
      setResult(stats);
      setPreview(null);
      window.dispatchEvent(new Event('teamcrm:tasks-changed'));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Импорт не удался');
    } finally {
      setBusy(false);
    }
  };

  /** Колонка занята другим полем: одну и ту же колонку в два поля не кладём. */
  const takenBy = (index: number, field: string) =>
    Object.entries(mapping).find(([k, v]) => k !== field && v === index)?.[0];

  return (
    <div className="import-file">
      <p className="dim">
        Переезд из другой системы: выгрузите задачи в CSV или Excel и загрузите файл сюда.
        Так переносятся выгрузки Trello, Notion, Asana, Jira и любые свои таблицы —
        ключи и доступы для этого не нужны.
      </p>

      {!preview && (
        <div
          className="file-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files?.[0]); }}
        >
          <label className="btn btn-sm file-pick">
            <Icon name="upload" size={14} /> Выбрать файл
            <input
              className="file-pick-input"
              type="file"
              accept=".csv,.xlsx,.xlsm,text/csv"
              aria-label="Файл с задачами"
              onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }}
            />
          </label>
          <span className="dim">или перетащите сюда · CSV, XLSX · до 10 МБ</span>
        </div>
      )}

      {busy && <div className="dim" style={{ marginTop: 8 }}>Читаю файл…</div>}
      {err && <div className="error-text">{err}</div>}

      {result && (
        <div className="import-result">
          <div className="import-result-head">
            <Icon name="check-circle" size={16} /> Импорт завершён
          </div>
          <div className="import-nums">
            <span><b>{result.created}</b> создано</span>
            <span><b>{result.updated}</b> обновлено</span>
            <span><b>{result.skipped}</b> пропущено</span>
          </div>
          {result.projects.length > 0 && (
            <div className="dim">Новые проекты: {result.projects.join(', ')}</div>
          )}
          {result.warnings.length > 0 && (
            // Предупреждения показываем ВСЕГДА и целиком: импорт без отчёта — лотерея.
            <ul className="import-warnings">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {preview && (
        <>
          <div className="import-head">
            <span><Icon name="file" size={14} /> {preview.fileName}</span>
            <span className="dim">строк: {preview.totalRows}</span>
            {preview.truncated && <span className="badge badge-warn">взяты первые 5000</span>}
            <button className="btn btn-ghost btn-sm" onClick={() => { setPreview(null); setErr(''); }}>
              Другой файл
            </button>
          </div>

          <div className="drawer-section">
            <div className="drawer-section-title">Куда грузим</div>
            <div className="import-target">
              <label className="notify-row">
                <input
                  type="radio" checked={target.mode === 'new'}
                  onChange={() => setTarget((t) => ({ ...t, mode: 'new' }))}
                />
                Новый проект
              </label>
              {target.mode === 'new' && (
                <input
                  className="input" value={target.name} placeholder="Название проекта"
                  onChange={(e) => setTarget((t) => ({ ...t, name: e.target.value }))}
                />
              )}
              <label className="notify-row">
                <input
                  type="radio" checked={target.mode === 'existing'}
                  onChange={() => setTarget((t) => ({ ...t, mode: 'existing' }))}
                />
                В существующий
              </label>
              {target.mode === 'existing' && (
                <select
                  className="input" value={target.projectId}
                  onChange={(e) => setTarget((t) => ({ ...t, projectId: e.target.value }))}
                >
                  <option value="">— выберите проект —</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
            </div>
            <div className="dim">
              Если в файле есть колонка «Проект», она главнее: задачи разъедутся по проектам с
              такими названиями, а недостающие проекты заведутся сами.
            </div>
          </div>

          <div className="drawer-section">
            <div className="drawer-section-title">Что в какой колонке</div>
            <table className="import-map">
              <tbody>
                {fields.map((f) => {
                  const value = mapping[f.key];
                  const conflict = value !== undefined ? takenBy(value, f.key) : undefined;
                  return (
                    <tr key={f.key}>
                      <td className="import-map-field">
                        {f.label}
                        {f.key === 'title' && <span className="req"> *</span>}
                        <span className="dim">{f.hint}</span>
                      </td>
                      <td>
                        <select
                          className="input"
                          value={value === undefined ? '' : String(value)}
                          onChange={(e) => setMapping((m) => {
                            const next = { ...m };
                            if (e.target.value === '') delete next[f.key];
                            else next[f.key] = Number(e.target.value);
                            return next;
                          })}
                        >
                          <option value="">— не переносить —</option>
                          {preview.headers.map((h, i) => (
                            <option key={i} value={i}>{h}</option>
                          ))}
                        </select>
                        {conflict && <span className="error-text">эта колонка уже занята полем «{conflict}»</span>}
                      </td>
                      <td className="import-map-sample dim">
                        {value !== undefined
                          ? (preview.sample.map((r) => r[value]).find(Boolean) ?? '—')
                          : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="drawer-section">
            <div className="drawer-section-title">Первые строки файла</div>
            <div className="import-sample">
              <table>
                <thead>
                  <tr>{preview.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.sample.slice(0, 5).map((row, i) => (
                    <tr key={i}>{row.map((c, j) => <td key={j}>{c.slice(0, 60)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <button
            className="btn btn-primary"
            onClick={run}
            disabled={busy || mapping.title === undefined || (target.mode === 'existing' && !target.projectId)}
          >
            {busy ? 'Импортирую…' : `Импортировать ${preview.totalRows} строк`}
          </button>
          {mapping.title === undefined && (
            <div className="dim">Укажите колонку с названием задачи — без неё импортировать нечего.</div>
          )}
        </>
      )}
    </div>
  );
}
