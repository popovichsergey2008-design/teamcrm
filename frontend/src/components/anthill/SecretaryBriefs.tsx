import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { SecretaryPrefs } from '../../lib/api';
import { RichText } from '../RichText';
import { Select } from '../ui/select';

/**
 * Личные сводки секретаря (ТЗ-18): утром — что сегодня, вечером — что сделано и что
 * завтра. Время и канал выбирает сам человек; пустое время — сводки нет. «Показать»
 * собирает сводку по сегодняшним данным — видно, что именно будет приходить.
 */
export function SecretaryBriefs() {
  const [p, setP] = useState<SecretaryPrefs | null>(null);
  const [shown, setShown] = useState<{ kind: string; text: string } | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => { api.secretaryPrefs().then(setP).catch(() => undefined); }, []);
  if (!p) return null;

  const save = async (patch: Partial<SecretaryPrefs>) => {
    setErr('');
    try { setP(await api.saveSecretaryPrefs(patch)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить'); }
  };
  const show = async (kind: 'morning' | 'evening') => {
    setErr('');
    try { setShown({ kind, text: (await api.secretaryBrief(kind)).text }); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось собрать сводку'); }
  };

  const row = (kind: 'morning' | 'evening', label: string, hint: string) => {
    const value = kind === 'morning' ? p.morningAt : p.eveningAt;
    return (
      <div className="anthill-adm-day">
        <span className="anthill-adm-text">
          <span>{label}</span>
          <span className="dim">{value ? hint : 'выключено — укажите время, чтобы включить'}</span>
        </span>
        <span className="anthill-form-acts">
          <input
            className="input anthill-adm-num"
            type="time"
            value={value ?? ''}
            aria-label={label}
            onChange={(e) => { void save(kind === 'morning' ? { morningAt: e.target.value || null } : { eveningAt: e.target.value || null }); }}
          />
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { void show(kind); }}>Показать</button>
        </span>
      </div>
    );
  };

  return (
    <div className="anthill-group">
      <div className="anthill-group-head">Сводки секретаря</div>
      <div className="anthill-card">
        {row('morning', 'Утром — ваш день', 'встречи, сроки, просрочки, что ждёт вашего решения')}
        {row('evening', 'Вечером — итоги', 'что сделано, что перенесено, что завтра; в пятницу — итоги недели')}
        <div className="anthill-adm-day">
          <span className="anthill-adm-text">
            <span>Перед встречей — справка</span>
            <span className="dim">клиент, цель, прошлые решения, просрочки участников; без фактов не приходит</span>
          </span>
          <Select
            ariaLabel="Справка перед встречей"
            size="sm"
            value={p.meetingBriefMin ? String(p.meetingBriefMin) : 'off'}
            onValueChange={(v) => { void save({ meetingBriefMin: v === 'off' ? null : Number(v) }); }}
            options={[
              { value: 'off', label: 'Не нужна' },
              { value: '10', label: 'За 10 минут' },
              { value: '15', label: 'За 15 минут' },
              { value: '30', label: 'За 30 минут' },
              { value: '60', label: 'За час' },
            ]}
          />
        </div>
        <label className="anthill-adm-row">
          <input type="checkbox" checked={p.weekdaysOnly} onChange={(e) => { void save({ weekdaysOnly: e.target.checked }); }} />
          <span className="anthill-adm-text"><span>Только в будни</span></span>
        </label>
        <label className="anthill-adm-row">
          <input type="checkbox" checked={p.channels.push} onChange={(e) => { void save({ channels: { ...p.channels, push: e.target.checked } }); }} />
          <span className="anthill-adm-text"><span>Уведомлением на телефон</span><span className="dim">в приложении сводка будет всегда</span></span>
        </label>
        <label className="anthill-adm-row">
          <input type="checkbox" checked={p.channels.telegram} onChange={(e) => { void save({ channels: { ...p.channels, telegram: e.target.checked } }); }} />
          <span className="anthill-adm-text"><span>В Telegram</span><span className="dim">если бот привязан в личном кабинете</span></span>
        </label>
        {err && <div className="error-text">{err}</div>}
        {shown && (
          <div className="anthill-task-what">
            <b>{shown.kind === 'morning' ? 'Ваш день' : 'Итоги дня'}</b>
            <RichText text={shown.text} className="anthill-body" />
          </div>
        )}
      </div>
    </div>
  );
}
