import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { api, ApiError } from '../../lib/api';
import type { AnthillAdmin as Settings, AnthillUsage } from '../../lib/api';
import { useAuth } from '../../state/auth';
import { stampLabel } from '../../lib/chat-text';

const ROLES: { code: string; label: string }[] = [
  { code: 'owner', label: 'владелец' },
  { code: 'manager', label: 'руководитель' },
  { code: 'member', label: 'сотрудник' },
];

const LIMITS: { key: keyof Settings['limits']; label: string; hint: string }[] = [
  { key: 'requestsPerDay', label: 'Вопросов в сутки на человека', hint: 'дальше агент честно скажет, что лимит исчерпан' },
  { key: 'deepPerDay', label: 'Глубоких разборов в сутки', hint: 'каждый дороже обычного вопроса в разы; 0 — выключить' },
  { key: 'maxScheduled', label: 'Регулярных задач на человека', hint: 'их выполняет сервер по расписанию' },
  { key: 'maxSkills', label: 'Навыков на человека', hint: 'свои сценарии работы' },
  { key: 'contextMessages', label: 'Сообщений разговора в подсказке', hint: 'больше памяти в ответе — дороже каждый запрос' },
];

/**
 * Администрирование агента (ТЗ-6, разд. 52–53).
 *
 * Здесь решают не «как красивее», а «что агенту вообще позволено»: кому он
 * доступен, может ли он писать в CRM, читать файлы и ходить в интернет, и сколько
 * это стоит в сутки. Поэтому рядом с выключателями — расход и последние сбои: без
 * них лимиты назначаются наугад.
 *
 * Смотрит руководство, меняет владелец.
 */
export function AnthillAdmin() {
  const { user } = useAuth();
  const canEdit = user?.role === 'owner';
  const [s, setS] = useState<Settings | null>(null);
  const [usage, setUsage] = useState<AnthillUsage | null>(null);
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    api.anthillAdmin().then(setS).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось прочитать настройки'));
    api.anthillUsage().then(setUsage).catch(() => undefined);
  }, []);
  useEffect(() => load(), [load]);

  const save = async (patch: Parameters<typeof api.anthillSaveAdmin>[0]) => {
    setErr(''); setSaved(false);
    try {
      setS(await api.anthillSaveAdmin(patch));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить'); }
  };

  if (!s) return <div className="anthill-pane"><div className="dim">{err || 'Читаю настройки…'}</div></div>;

  const toggle = (label: string, hint: string, value: boolean, onChange: (v: boolean) => void) => (
    <label className="anthill-adm-row">
      <input type="checkbox" checked={value} disabled={!canEdit} onChange={(e) => onChange(e.target.checked)} />
      <span className="anthill-adm-text">
        <span>{label}</span>
        <span className="dim">{hint}</span>
      </span>
    </label>
  );

  return (
    <div className="anthill-pane">
      {!canEdit && <div className="dim">Настройки меняет владелец организации. Здесь они только показаны.</div>}
      {err && <div className="error-text">{err}</div>}
      {saved && <div className="dim"><Icon name="check" size={12} /> Сохранено</div>}

      <div className="anthill-group">
        <div className="anthill-group-head">Что агенту позволено</div>
        <div className="anthill-card">
          {toggle('AnthillBot включён', 'выключенный отвечает понятной фразой, а не молчанием', s.enabled, (v) => void save({ enabled: v }))}
          {toggle('Может менять CRM', 'создавать задачи, переносить сроки, писать сообщения — всегда с подтверждением человека', s.actionsAllowed, (v) => void save({ actionsAllowed: v }))}
          {toggle('Может читать файлы и собирать документы', 'вложения задач и чатов: PDF, docx, xlsx, txt, csv', s.filesAllowed, (v) => void save({ filesAllowed: v }))}
          {toggle('Может искать в интернете', 'по умолчанию агент работает только на данных ANTHILL', s.webSearch, (v) => void save({ webSearch: v }))}
        </div>
      </div>

      {s.webSearch && (
        <div className="anthill-group">
          <div className="anthill-group-head">Ключ поиска</div>
          <div className="anthill-card">
            <div className="dim">
              Поиск идёт через Tavily. {s.hasWebSearchKey ? 'Ключ задан.' : 'Ключа нет — агент будет отвечать только по данным ANTHILL и скажет об этом.'}
            </div>
            {canEdit && (
              <div className="anthill-form-acts">
                <input
                  className="input"
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={s.hasWebSearchKey ? 'новый ключ (оставьте пустым — не менять)' : 'tvly-…'}
                  aria-label="Ключ поиска"
                />
                <button className="btn btn-primary btn-sm" disabled={!key.trim()} onClick={() => { void save({ webSearchKey: key.trim() }).then(() => setKey('')); }}>Сохранить ключ</button>
                {s.hasWebSearchKey && (
                  <button className="btn btn-ghost btn-sm" onClick={() => { void save({ webSearchKey: '' }); }}>Убрать</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="anthill-group">
        <div className="anthill-group-head">Кому доступен</div>
        <div className="anthill-card anthill-adm-roles">
          {ROLES.map((r) => (
            <label key={r.code} className="anthill-ctx">
              <input
                type="checkbox"
                checked={s.allowedRoles.includes(r.code)}
                disabled={!canEdit}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...s.allowedRoles, r.code]
                    : s.allowedRoles.filter((x) => x !== r.code);
                  void save({ allowedRoles: next });
                }}
              />
              {r.label}
            </label>
          ))}
        </div>
      </div>

      <div className="anthill-group">
        <div className="anthill-group-head">Лимиты</div>
        <div className="anthill-card">
          {LIMITS.map((l) => (
            <label key={l.key} className="anthill-adm-row">
              <input
                className="input anthill-adm-num"
                type="number"
                min={0}
                defaultValue={s.limits[l.key]}
                disabled={!canEdit}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v !== s.limits[l.key]) void save({ limits: { ...s.limits, [l.key]: v } });
                }}
              />
              <span className="anthill-adm-text">
                <span>{l.label}</span>
                <span className="dim">{l.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="anthill-group">
        <div className="anthill-group-head">Расход за две недели</div>
        <div className="anthill-card">
          {usage && usage.days.length === 0 && <div className="dim">Агентом пока не пользовались.</div>}
          {usage?.days.map((d) => (
            <div key={d.day} className="anthill-adm-day">
              <span>{d.day}</span>
              <span className="dim">{d.requests} обращений · {Math.round(d.tokens / 1000)}k токенов</span>
              <span>${d.cost.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="anthill-group">
        <div className="anthill-group-head">Последние сбои</div>
        <div className="anthill-card">
          {(!usage || usage.errors.length === 0) && <div className="dim">Сбоев нет.</div>}
          {usage?.errors.map((e) => (
            <div key={`${e.kind}-${e.id}`} className="anthill-adm-err">
              <span className="badge badge-muted">{e.kind === 'task' ? 'регулярная задача' : 'действие'}</span>
              <span className="anthill-mem-title">{e.title}</span>
              <span className="dim">{e.who ?? '—'} · {e.at ? stampLabel(e.at) : ''}</span>
              <div className="error-text">{e.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
