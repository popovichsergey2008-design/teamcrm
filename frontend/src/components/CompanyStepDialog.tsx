import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import { AuthedMedia } from './AuthedMedia';
import { navigate } from '../lib/router';
import type { Industry, OnboardingView } from '../types';

/**
 * Шаг «Настроить компанию» (ТЗ-11, разд. 16–17, 20–22).
 *
 * Два поля, и оба не косметика:
 *
 *   — ЧАСОВОЙ ПОЯС организации. По нему считаются сроки без указания времени,
 *     напоминания, тихие часы и утренние сводки. Пока его не было, всё это жило по
 *     Москве, даже если компания работает во Владивостоке. Предлагаем тот, что
 *     определил браузер, — подтвердить проще, чем искать в списке из сотни строк;
 *   — ОТРАСЛЬ. Нужна не для статистики: по ней на следующем шаге предлагается набор
 *     отделов. «Продажи, маркетинг, разработка» подходят ИТ-компании и выглядят чужими
 *     у строителей.
 */
export function CompanyStepDialog({ company, onClose, onSaved }: {
  company: { name: string; timezone: string; industry: string | null; logoFileId: string | null };
  onClose: () => void;
  onSaved: (view: OnboardingView) => void;
}) {
  useEscape(onClose);
  const [industries, setIndustries] = useState<Industry[]>([]);
  const [name, setName] = useState(company.name);
  /*
    Пояс, определённый браузером, — это и есть ответ в девяти случаях из десяти.
    Показываем его как предложение, а не молча сохраняем: организация может работать
    не там, где сидит её владелец.
  */
  const guessed = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [timezone, setTimezone] = useState(company.timezone || guessed || 'Europe/Moscow');
  const [industry, setIndustry] = useState(company.industry ?? '');
  const [logo, setLogo] = useState(company.logoFileId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.onboardingIndustries().then(setIndustries).catch(() => setIndustries([])); }, []);

  const save = async () => {
    setBusy(true); setErr('');
    try {
      onSaved(await api.saveCompany({
        name: name.trim() || undefined,
        timezone,
        industry: industry || undefined,
      }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не сохранилось');
      setBusy(false);
    }
  };

  const zones = zoneList(timezone, guessed);

  return (
    <div className="modal-overlay" {...overlayProps(onClose)}>
      <div className="modal-card onb-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="settings" size={16} /> Настройки компании</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="field">
          <label htmlFor="onb-name">Название компании</label>
          <input id="onb-name" className="input" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="onb-tz">Часовой пояс</label>
          <select id="onb-tz" className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => <option key={z} value={z}>{z === guessed ? `${z} — определили по вашему компьютеру` : z}</option>)}
          </select>
          <span className="dim tpl-hint">
            По нему считаются сроки, напоминания и тихие часы. У каждого сотрудника пояс
            может быть свой — этот отвечает за компанию в целом.
          </span>
        </div>

        <div className="field">
          <label htmlFor="onb-industry">Чем занимается компания</label>
          <select id="onb-industry" className="input" value={industry} onChange={(e) => setIndustry(e.target.value)}>
            <option value="">— не выбрано —</option>
            {industries.map((i) => <option key={i.code} value={i.code}>{i.title}</option>)}
          </select>
          <span className="dim tpl-hint">
            По отрасли на следующем шаге предложим отделы — останется подтвердить.
          </span>
        </div>

        {/*
          Логотип — не украшение: он стоит в шапке и в гостевых экранах, где заказчик
          видит систему впервые и должен понять, чьё это пространство.
        */}
        <div className="field">
          <label>Логотип</label>
          <div className="onb-logo">
            {/* Файлы лежат за авторизацией: обычный <img src> получил бы отказ. */}
            {logo
              ? <AuthedMedia fileId={logo} name="Логотип компании" mime="image/png" className="onb-logo-img" />
              : <span className="onb-logo-empty"><Icon name="building" size={20} /></span>}
            <label className="ui-btn ui-btn-outline ui-btn-sm">
              {logo ? 'Заменить' : 'Загрузить'}
              <input
                type="file"
                hidden
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.currentTarget.value = '';
                  if (!file) return;
                  setErr('');
                  try { setLogo((await api.uploadLogo(file)).logoFileId); }
                  catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'Логотип не загрузился'); }
                }}
              />
            </label>
            {logo && (
              <button
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => { void api.clearLogo().then(() => setLogo(null)).catch(() => undefined); }}
              >
                Убрать
              </button>
            )}
          </div>
          <span className="dim tpl-hint">PNG, JPG, WEBP или SVG. Виден в шапке и на гостевых экранах.</span>
        </div>

        {/*
          Telegram — предложением, а не ещё одним шагом пути (ТЗ-11, разд. 19).

          Привязка личная: бот пишет человеку в его чат, а не компании. Поэтому ведём
          в профиль, где она уже живёт, вместо того чтобы заводить вторую такую же.
        */}
        <div className="onb-tg">
          <div>
            <b>Telegram</b>
            <div className="dim tpl-hint">
              Уведомления и сводки в личный чат, задачи и дейлики голосом. Подключается
              каждым сотрудником отдельно — начните с себя.
            </div>
          </div>
          <button
            className="ui-btn ui-btn-outline ui-btn-sm"
            onClick={() => { onClose(); navigate({ section: 'profile' }); }}
          >
            Подключить
          </button>
        </div>

        {err && <div className="error-text">{err}</div>}

        <div className="modal-actions">
          <button className="ui-btn ui-btn-ghost ui-btn-md" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="ui-btn ui-btn-primary ui-btn-md" onClick={save} disabled={busy}>
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Список поясов для выбора.
 *
 * Полный перечень браузера — это шесть сотен строк, среди которых человек ищет свой
 * город минуту. Показываем то, чем реально пользуются наши компании, плюс пояс,
 * определённый браузером, и уже сохранённый — чтобы ни один из них не пропал из списка.
 */
function zoneList(current: string, guessed: string): string[] {
  const common = [
    'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Kyiv', 'Europe/Minsk',
    'Europe/Warsaw', 'Europe/Berlin', 'Europe/London', 'Europe/Lisbon',
    'Asia/Tbilisi', 'Asia/Yerevan', 'Asia/Baku', 'Asia/Almaty', 'Asia/Tashkent',
    'Asia/Dubai', 'Asia/Jerusalem', 'Asia/Bangkok', 'Asia/Shanghai',
    'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Krasnoyarsk',
    'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Kamchatka',
    'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  ];
  return [...new Set([guessed, current, ...common].filter(Boolean))];
}
