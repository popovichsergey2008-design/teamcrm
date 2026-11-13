import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Select } from '../../components/ui/select';
import { ApiError } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { pulseApi, WeeklyPrefs } from './pulse-api';

const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const TIMES = Array.from({ length: 28 }, (_, i) => `${String(7 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

/**
 * «Пульс недели» в Telegram (#4890, п. 12): по умолчанию понедельник 9:00; можно
 * выключить или перенести. Тут же — как выглядит сводка сейчас.
 */
export function WeeklyDialog({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState<WeeklyPrefs | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pulseApi.weeklyPrefs().then(setP).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить'));
    pulseApi.weeklyPreview().then((r) => setPreview(r.text)).catch(() => undefined);
  }, []);
  const save = async () => {
    if (!p) return;
    setBusy(true);
    try { setP(await pulseApi.saveWeekly(p)); toastSaved('Сохранено', p.enabled ? `«Пульс недели»: ${DAYS[p.weekday]}, ${p.atTime}` : '«Пульс недели» выключен'); onClose(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не сохранилось'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="md" title="«Пульс недели» в Telegram"
      description="Раз в неделю QEVO Bot присылает индекс и изменение за неделю, главное, главную пробку, 3 шага и ссылку сразу в разбор решений. Нужен привязанный Telegram (Личный кабинет → «Открыть бота»)."
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" loading={busy} disabled={!p} onClick={() => void save()}>Сохранить</Button>
        </>
      )}>
      {p && (
        <div className="pulse-weekly">
          <label className="pulse-pick-row"><input type="checkbox" checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} /> Присылать сводку</label>
          <div className="pulse-acts">
            <Select ariaLabel="День недели" value={String(p.weekday)} onValueChange={(v) => setP({ ...p, weekday: Number(v) })}
              options={[1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: DAYS[d] }))} />
            <Select ariaLabel="Время" value={p.atTime} onValueChange={(v) => setP({ ...p, atTime: v })}
              options={(TIMES.includes(p.atTime) ? TIMES : [p.atTime, ...TIMES]).map((t) => ({ value: t, label: t }))} />
          </div>
        </div>
      )}
      {preview && (
        <>
          <div className="dim pulse-small">Так выглядит сводка сейчас:</div>
          <div className="pulse-preview">{preview}{'\n\n'}Открыть разбор в Qevo →</div>
        </>
      )}
      {err && <div className="error-text">{err}</div>}
    </Dialog>
  );
}
