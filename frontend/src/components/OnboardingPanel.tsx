import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { OnboardingCard } from './OnboardingCard';
import type { OnboardingView } from '../types';

/**
 * «Настройка ANTHILL» в настройках (ТЗ-11, разд. 74).
 *
 * Подсказку с «Фокуса дня» можно убрать, а путь при этом остаётся — сюда и приходят,
 * чтобы посмотреть, что ещё не сделано, или вернуть её на главный экран.
 *
 * Здесь же видно завершённый путь: на «Фокусе дня» он намеренно исчезает, но человек
 * вправе убедиться, что ничего не пропустил.
 */
export function OnboardingPanel({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  const [view, setView] = useState<OnboardingView | null>(null);
  const [err, setErr] = useState('');

  const load = () => api.onboarding().then(setView).catch(() => setView(null));
  useEffect(() => { void load(); }, []);

  const show = () => {
    setErr('');
    api.dismissOnboarding(false).then(setView)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не получилось'));
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="target" size={18} /> Настройка ANTHILL</h3>
          <button className="drawer-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <Icon name="close" size={20} />
          </button>
        </div>

        {!view && <div className="dim">Загружаю…</div>}

        {view && (
          <>
            {view.completed && (
              <div className="dim onb-hint">
                Путь пройден: пространство, первый проект и первая задача есть. Ниже видно,
                что осталось необязательного — к этому можно вернуться в любой момент.
              </div>
            )}

            {/*
              Ту же карточку, что и на «Фокусе дня», показываем здесь принудительно:
              человек пришёл именно за ней, и прятать её по тем же правилам незачем.
            */}
            <OnboardingCard always />

            {view.dismissed && (
              <button className="btn btn-sm" onClick={show}>
                <Icon name="eye" size={14} /> Показывать подсказку на «Фокусе дня»
              </button>
            )}
            {err && <div className="error-text">{err}</div>}
          </>
        )}
      </aside>
    </div>
  );
}
