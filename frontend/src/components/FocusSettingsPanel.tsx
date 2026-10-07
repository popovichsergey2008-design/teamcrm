import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import { toastSaved } from '../lib/notifications';

type Settings = Awaited<ReturnType<typeof api.focusSettingsView>>;

const pct = (v: number | null) => (v == null ? '—' : `${v}%`);

/**
 * «Фокус дня» в настройках (ТЗ-16, волны 9–10).
 *
 * Включает новый экран владелец — для всей организации сразу: обкатали у себя, потом
 * всем. Ниже — как он работает за две недели. Считается по самим планам: принят ли
 * как есть, что меняли и почему, дошли ли до глубокой работы и закрытия дня. Ни
 * клавиатуры, ни экранов — только то, что люди сделали в фокусе сами.
 */
export function FocusSettingsPanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.focusSettingsView().then(setS).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить'));
  }, []);

  const toggle = async () => {
    if (!s || !canManage || saving) return;
    setSaving(true); setErr('');
    try {
      const r = await api.focusSettings(!s.enabled);
      setS({ ...s, enabled: r.enabled });
      toastSaved(r.enabled ? 'Новый «Фокус дня» включён' : 'Вернули прежний «Фокус дня»');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const rows: [string, string, string][] = s ? [
    ['Планов собрано', String(s.plans), `у ${s.people} чел. за ${s.days} дней`],
    ['Приняли как есть', pct(s.acceptedAsIs), 'тройку угадали без правок'],
    ['Поправили', pct(s.corrected), 'заменили, убрали или добавили своё'],
    ['Главная миссия устояла', pct(s.rank1Kept), '#1 от системы не заменили'],
    ['«Неверный приоритет»', String(s.wrongPriority), 'столько раз так объяснили замену'],
    ['Тройка выполнена', pct(s.topCompletion), 'сделанных главных действий'],
    ['Начинали глубокий фокус', pct(s.deepStart), 'дней с хотя бы одним фокусом'],
    ['Доводили фокус до конца', pct(s.deepCompletion), `из ${s.sessions} сессий`],
    ['Закрывали день', pct(s.closeDay), '«Завершить день и подвести итоги»'],
    ['Со встреч — в фокус', String(s.huddleInFocus), 'поручений со встреч попали в тройку'],
    ['Оценка плана', `👍 ${s.thumbsUp} · 👎 ${s.thumbsDown}`, '«Полезный план?»'],
  ] : [];

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="target" size={18} /> Фокус дня</h3>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>
        <div className="dim gate-panel-hint">
          Новый «Фокус дня»: утром система сама собирает три главных действия с объяснением,
          глубокая работа с таймером и тишиной, «Команда сейчас», поручения со встреч и
          «Завершить день». Включается для всей организации.
        </div>
        {err && <div className="error-text">{err}</div>}
        {s && (
          <>
            <button className={`mode-row${s.enabled ? ' mode-row-on' : ''}`} disabled={!canManage || saving} onClick={() => void toggle()}>
              <Icon name={s.enabled ? 'check-circle' : 'target'} size={16} />
              <span>
                <span className="mode-title">{s.enabled ? 'Новый «Фокус дня» включён' : 'Включить новый «Фокус дня»'}</span>
                <span className="dim mode-hint">
                  {canManage
                    ? (s.enabled ? 'Нажмите, чтобы вернуть прежний экран из трёх колонок.' : 'У всех сотрудников откроется новый экран. Вернуть прежний можно здесь же.')
                    : 'Включает владелец организации.'}
                </span>
              </span>
              {s.enabled && <Icon name="check" size={15} />}
            </button>

            <div className="drawer-section-title" style={{ marginTop: 18 }}>Как работает за {s.days} дней</div>
            {s.plans === 0 ? (
              <div className="dim">Планов ещё нет — цифры появятся, когда люди начнут открывать новый фокус.</div>
            ) : (
              <table className="focus-metrics" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <tbody>
                  {rows.map(([title, value, hint]) => (
                    <tr key={title} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '7px 0' }}>{title}<div className="dim" style={{ fontSize: 12 }}>{hint}</div></td>
                      <td style={{ padding: '7px 0', textAlign: 'right', fontWeight: 650, whiteSpace: 'nowrap' }}>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
