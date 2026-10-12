import { useEffect, useRef, useState } from 'react';
import './guest/guest.css';
import { Icon } from './Icon';
import { api, ApiError, GuestBrandSettings } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import { toastSaved } from '../lib/notifications';

type Metrics = Awaited<ReturnType<typeof api.guestBrandMetrics>>;

/**
 * «Гостевая страница» в настройках (ТЗ-28, п. 10–12, 67): как выглядит встреча для
 * клиента — логотип, цвет, приветствие, подпись, «Сделано в QEVO», предупреждение о
 * записи и сколько дней клиент видит итоги. Справа — предпросмотр глазами гостя.
 */
export function GuestBrandPanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [s, setS] = useState<GuestBrandSettings | null>(null);
  const [m, setM] = useState<Metrics | null>(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api.guestBrandSettings().then(setS).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить'));
    api.guestBrandMetrics().then(setM).catch(() => setM(null));
  }, []);

  const save = async (patch: Parameters<typeof api.guestBrandSave>[0]) => {
    if (!canManage) return;
    setSaving(true); setErr('');
    try { setS(await api.guestBrandSave(patch)); toastSaved('Сохранено'); } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally { setSaving(false); }
  };

  const uploadLogo = async (f: File) => {
    setSaving(true); setErr('');
    try {
      const up = await api.uploadFile(f, 'guest_brand');
      setS(await api.guestBrandSave({ logoFileId: String(up.id) }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Логотип не загрузился');
    } finally { setSaving(false); }
  };

  const p = s?.preview;
  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="users" size={18} /> Гостевая страница</h3>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>
        <div className="dim gate-panel-hint">
          Так клиент видит встречу по ссылке: без регистрации, с вашим логотипом и цветом, а после встречи — с итогами,
          которые вы опубликуете. {canManage ? '' : 'Настраивает владелец организации.'}
        </div>
        {err && <div className="error-text">{err}</div>}
        {s && p && (
          <div className="gbp">
            <fieldset className="gbp-form" disabled={!canManage || saving}>
              <label className="field"><span>Название для клиентов</span>
                <input className="input" defaultValue={s.companyName ?? ''} placeholder={s.tenantName} maxLength={120} onBlur={(e) => e.target.value !== (s.companyName ?? '') && void save({ companyName: e.target.value })} />
              </label>
              <div className="field"><span>Логотип</span>
                <div className="gbp-row">
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadLogo(f); e.target.value = ''; }} />
                  <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => fileRef.current?.click()}><Icon name="upload" size={13} /> {s.logoFileId ? 'Заменить' : 'Загрузить'}</button>
                  {s.logoFileId && <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => void save({ logoFileId: null })}>Убрать</button>}
                </div>
              </div>
              <label className="field"><span>Фирменный цвет</span>
                <div className="gbp-row">
                  <input type="color" value={s.accent ?? '#4f46e5'} onChange={(e) => void save({ accent: e.target.value })} aria-label="Фирменный цвет" />
                  {s.accent && p.accent && p.accent !== s.accent && <span className="dim gbp-note">затемнён до {p.accent}, чтобы текст на кнопках читался</span>}
                  {s.accent && <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => void save({ accent: null })}>Сбросить</button>}
                </div>
              </label>
              <label className="field"><span>Фон</span>
                <select className="input" value={s.background} onChange={(e) => void save({ background: e.target.value })}>
                  <option value="soft">Мягкий оттенок</option>
                  <option value="gradient">Градиент</option>
                  <option value="plain">Без фона</option>
                </select>
              </label>
              <label className="field"><span>Приветствие</span>
                <textarea className="input" rows={2} maxLength={400} defaultValue={s.welcomeText ?? ''} placeholder="Рады встрече! Подключайтесь из браузера — ничего устанавливать не нужно." onBlur={(e) => e.target.value !== (s.welcomeText ?? '') && void save({ welcomeText: e.target.value })} />
              </label>
              <label className="field"><span>Подпись внизу</span>
                <input className="input" maxLength={200} defaultValue={s.footerText ?? ''} placeholder="ООО «Агентство» · +7 …" onBlur={(e) => e.target.value !== (s.footerText ?? '') && void save({ footerText: e.target.value })} />
              </label>
              <label className="gbp-check"><input type="checkbox" checked={s.recordingNotice} onChange={(e) => void save({ recordingNotice: e.target.checked })} /> Предупреждать гостя о записи и ИИ-протоколе</label>
              <label className="gbp-check"><input type="checkbox" checked={s.consentRequired} disabled={!s.recordingNotice} onChange={(e) => void save({ consentRequired: e.target.checked })} /> Без отметки согласия не пускать</label>
              <label className="gbp-check"><input type="checkbox" checked={s.poweredBy} onChange={(e) => void save({ poweredBy: e.target.checked })} /> Показывать «Сделано в QEVO»</label>
              <label className="field"><span>Сколько дней клиент видит итоги</span>
                <input className="input" type="number" min={1} max={365} defaultValue={s.summaryDays} onBlur={(e) => Number(e.target.value) !== s.summaryDays && void save({ summaryDays: Number(e.target.value) })} />
              </label>
            </fieldset>

            <div className="drawer-section-title">Предпросмотр</div>
            <div className={`gbp-preview guest-branded guest-bg-${p.background ?? 'soft'}`} style={p.accent ? ({ '--guest-accent': p.accent } as React.CSSProperties) : undefined}>
              <div className="guest-brand-head">
                {p.logoUrl && <img className="guest-brand-logo" src={p.logoUrl} alt="" />}
                <div className="guest-brand-name">{p.companyName}</div>
              </div>
              {p.welcomeText && <p className="guest-welcome">{p.welcomeText}</p>}
              <button type="button" className="ui-btn ui-btn-primary ui-btn-md auth-submit" tabIndex={-1}>Войти во встречу</button>
              <div className="guest-footer">
                {p.footerText && <span>{p.footerText}</span>}
                {p.poweredBy && <span>Сделано в QEVO</span>}
              </div>
            </div>

            {m && (m.opened > 0 || m.published > 0) && (
              <>
                <div className="drawer-section-title">За {m.days} дней</div>
                <div className="gbp-metrics">
                  <span>Открыли ссылку: <b>{m.opened}</b></span>
                  <span>Вошли во встречу: <b>{m.joined}</b></span>
                  <span>Опубликовано итогов: <b>{m.published}</b></span>
                  <span>Прочитали итоги: <b>{m.viewed}</b></span>
                  <span>Подтвердили договорённости: <b>{m.acknowledged}</b>{m.ackRate != null ? ` (${m.ackRate}%)` : ''}</span>
                  <span>Уточнений и вопросов: <b>{m.feedback}</b></span>
                </div>
              </>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
