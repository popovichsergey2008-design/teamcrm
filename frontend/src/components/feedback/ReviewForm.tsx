import { useRef, useState } from 'react';
import './feedback.css';
import { Icon } from '../Icon';
import { api, ApiError, request } from '../../lib/api';
import { useAuth } from '../../state/auth';
import { toastSaved } from '../../lib/notifications';

/**
 * «Профиль» → «Оставить отзыв» (ТЗ 10.11): имя, должность, компания, текст, фото по
 * желанию и согласие на публикацию на qevo.one. Отзыв приходит тому, кто ведёт сайт.
 */
export function ReviewForm() {
  const { user } = useAuth();
  const [name, setName] = useState(user?.fullName ?? '');
  const [position, setPosition] = useState('');
  const [company, setCompany] = useState('');
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<{ id: string; name: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!/^image\//.test(f.type)) { setErr('Фото — картинка JPG, PNG или WEBP'); return; }
    setErr(''); setBusy(true);
    try { const r = await api.uploadFile(f); setPhoto({ id: String(r.id), name: r.fileName }); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить фото'); }
    finally { setBusy(false); }
  };

  const send = async () => {
    setErr(''); setBusy(true);
    try {
      await request('POST', '/feedback/review', {
        name: name.trim(), position: position.trim() || undefined, company: company.trim() || undefined,
        text: text.trim(), photoFileId: photo?.id ?? null, consent,
      });
      setSent(true);
      toastSaved('Спасибо за отзыв!');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось отправить'); }
    finally { setBusy(false); }
  };

  if (sent) {
    return (
      <div className="review-form">
        <p><Icon name="check-circle" size={16} /> Спасибо! Отзыв отправлен — с вами свяжутся перед публикацией, если понадобится что-то уточнить.</p>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { setSent(false); setText(''); setPhoto(null); setConsent(false); }}>Написать ещё один</button>
      </div>
    );
  }
  return (
    <div className="review-form">
      <h3 style={{ marginTop: 0 }}>Оставить отзыв</h3>
      <p className="dim" style={{ marginTop: 0 }}>Расскажите, как QEVO помогает вашей команде. С вашего согласия отзыв опубликуем на qevo.one.</p>
      <label className="field"><span>Имя</span><input className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Должность</span><input className="input" maxLength={120} value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Например: руководитель отдела продаж" /></label>
      <label className="field"><span>Компания</span><input className="input" maxLength={160} value={company} onChange={(e) => setCompany(e.target.value)} /></label>
      <label className="field"><span>Текст отзыва</span><textarea className="input" rows={5} maxLength={3000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Что изменилось с QEVO: задачи, созвоны, порядок в команде…" /></label>
      <div className="field">
        <span>Фото (необязательно)</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}><Icon name="paperclip" size={14} /> {photo ? 'Заменить фото' : 'Загрузить фото'}</button>
          {photo && <span className="dim">{photo.name} <button type="button" className="bb-link" onClick={() => setPhoto(null)}>убрать</button></span>}
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.currentTarget.value = ''; }} />
      </div>
      <label className="gbp-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Согласен на публикацию отзыва на qevo.one</label>
      {err && <p className="error-text" role="alert">{err}</p>}
      <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || !name.trim() || text.trim().length < 10 || !consent} onClick={() => void send()}>Отправить отзыв</button>
    </div>
  );
}
