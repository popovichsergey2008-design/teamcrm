import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { OptionSelect } from '../../components/ui/option-select';
import { api, ApiError } from '../../lib/api';

type Preview = Awaited<ReturnType<typeof api.clientImportPreview>>;
type Report = Awaited<ReturnType<typeof api.clientImport>>;

/**
 * Импорт клиентов (п. 50–52): файл → предпросмотр → сопоставление колонок → импорт →
 * отчёт. Похожие на существующих не создаются, а показываются «на проверку»; плохая
 * строка не ломает остальные.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [pre, setPre] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [onDup, setOnDup] = useState<'skip' | 'create'>('skip');
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const pick = async (f: File | null) => {
    setFile(f); setPre(null); setReport(null); setErr('');
    if (!f) return;
    setBusy(true);
    try {
      const p = await api.clientImportPreview(f);
      setPre(p); setMapping(p.mapping);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Файл не читается'); }
    finally { setBusy(false); }
  };

  const run = async () => {
    if (!file) return;
    setBusy(true); setErr('');
    try { setReport(await api.clientImport(file, mapping, onDup)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Импорт не удался'); }
    finally { setBusy(false); }
  };

  const hasName = Object.values(mapping).includes('name');
  return (
    <Dialog
      open size="lg"
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Импорт клиентов"
      description="CSV или Excel (.xlsx). Первая строка — заголовки колонок."
      footer={report ? <Button variant="primary" onClick={onClose}>Готово</Button> : (
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={!pre || !hasName || busy} onClick={() => void run()}>
            <Icon name="upload" size={14} /> Импортировать {pre ? pre.total : ''}
          </Button>
        </>
      )}
    >
      {!report && (
        <div className="cl-import">
          <label className="cl-file">
            <Icon name="paperclip" size={15} /> {file ? file.name : 'Выбрать файл'}
            <input type="file" accept=".csv,.xlsx,.txt" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
          </label>
          {busy && !pre && <span className="dim">Читаю файл…</span>}
          {pre && (
            <>
              <div className="dim">Строк: {pre.total}. Сопоставьте колонки — угаданное можно поправить.</div>
              <div className="cl-map">
                {pre.headers.map((h) => (
                  <label key={h} className="cl-map-row">
                    <span className="cl-map-head">{h}<span className="dim"> · {pre.sample[0]?.[pre.headers.indexOf(h)] ?? ''}</span></span>
                    <OptionSelect value={mapping[h] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value || null }))} aria-label={`Колонка «${h}»`}>
                      <option value="">Не загружать</option>
                      {pre.fields.map((f) => <option key={f.key} value={f.key}>{f.title}</option>)}
                    </OptionSelect>
                  </label>
                ))}
              </div>
              {!hasName && <div className="error-text">Укажите, в какой колонке название или имя клиента.</div>}
              <label className="cl-dupmode">
                <OptionSelect value={onDup} onChange={(e) => setOnDup(e.target.value as 'skip' | 'create')} aria-label="Похожие на существующих">
                  <option value="skip">Похожих на существующих — отложить на проверку</option>
                  <option value="create">Похожих — всё равно создавать</option>
                </OptionSelect>
              </label>
            </>
          )}
          {err && <div className="error-text" role="alert">{err}</div>}
        </div>
      )}
      {report && (
        <div className="cl-report">
          <div className="cl-report-nums">
            <div><b>{report.total}</b><span>строк</span></div>
            <div><b>{report.imported}</b><span>импортировано</span></div>
            <div><b>{report.skipped}</b><span>пропущено</span></div>
            <div><b>{report.review}</b><span>на проверку</span></div>
          </div>
          {report.errors.length > 0 && (
            <ul className="cl-report-list">
              {report.errors.map((e) => <li key={`${e.row}-${e.reason}`}>Строка {e.row}{e.name ? ` («${e.name}»)` : ''}: {e.reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
