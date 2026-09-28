import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import { CompanyStepDialog } from './CompanyStepDialog';
import { DepartmentsStepDialog } from './DepartmentsStepDialog';
import { InviteTeamDialog } from './InviteTeamDialog';
import type { OnboardingStep, OnboardingView } from '../types';

/**
 * Путь владельца: что уже сделано и что осталось (ТЗ-11, разд. 8).
 *
 * Это НЕ мастер, который ведёт за руку и блокирует остальное. Человек волен идти любым
 * порядком и мимо подсказки: шаги считает сервер по факту — создал проект из раздела
 * «Проекты», и шаг закрылся сам.
 *
 * Показываем только владельцу и только пока путь не пройден. Как только есть проект и
 * задача, подсказка исчезает и больше не навязывается — вернуть её можно из настроек.
 * Так требует ТЗ (разд. 74), и это правильно: подсказка, висящая над работающей
 * компанией, из помощи превращается в мусор на экране.
 */
export function OnboardingCard({ always = false }: {
  /**
   * Показывать, даже если подсказку убрали или путь пройден.
   *
   * Нужно в настройках: туда приходят именно за этим списком, и прятать его по тем же
   * правилам, что на «Фокусе дня», было бы издевательством.
   */
  always?: boolean;
}) {
  const [view, setView] = useState<OnboardingView | null>(null);
  const [open, setOpen] = useState(true);
  const [dialog, setDialog] = useState<'company' | 'departments' | 'team' | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    // Роль проверяет сервер: сотруднику ручка отвечает отказом, и это не ошибка экрана.
    api.onboarding().then(setView).catch(() => setView(null));
  }, []);

  if (!view) return null;
  if (!always && (view.dismissed || view.completed)) return null;

  const act = (fn: () => Promise<OnboardingView>) => {
    setErr('');
    fn().then(setView).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не сохранилось'));
  };

  /** Куда ведёт шаг. Настройки компании и отделы — свои окна, остальное — разделы. */
  const go = (step: OnboardingStep) => {
    if (step.key === 'company') return setDialog('company');
    if (step.key === 'departments') return setDialog('departments');
    if (step.key === 'team') return setDialog('team');
    // Проект и задача заводятся там же, где их заводят всегда: отдельного «мастера
    // создания» нет намеренно — человек должен запомнить настоящий путь, а не учебный.
    return navigate({ section: 'projects' });
  };

  return (
    <>
      <section className={`onb-card${open ? '' : ' onb-collapsed'}`} aria-label="Настройка ANTHILL">
        <header className="onb-head">
          <button
            className="onb-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={open ? 'Свернуть' : 'Развернуть'}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
            <span className="onb-title">Настройка ANTHILL</span>
            <span className="onb-progress">{view.done} / {view.total}</span>
          </button>
          {!always && <button
            className="onb-close"
            onClick={() => act(() => api.dismissOnboarding(true))}
            title="Убрать подсказку. Вернуть её можно в настройках"
            aria-label="Убрать подсказку"
          >
            <Icon name="close" size={16} />
          </button>}
        </header>

        {open && (
          <>
            <div className="onb-bar" aria-hidden="true">
              <span style={{ width: `${Math.round((view.done / view.total) * 100)}%` }} />
            </div>
            <ol className="onb-steps">
              {view.steps.map((s) => (
                <li key={s.key} className={`onb-step${s.done ? ' onb-done' : ''}${s.skipped ? ' onb-skipped' : ''}`}>
                  {/* Пустой кружок рисуем сами: значка «пустой круг» в наборе нет, а
                      заводить его ради одного места незачем. */}
                  <span className="onb-mark" aria-hidden="true">
                    {s.done ? <Icon name="check-circle" size={16} /> : <span className="onb-dot" />}
                  </span>
                  <span className="onb-body">
                    <span className="onb-step-title">{s.title}</span>
                    <span className="dim onb-hint">{s.skipped ? 'Отложено — можно вернуться в любой момент.' : s.hint}</span>
                  </span>
                  {!s.done && (
                    <span className="onb-actions">
                      <button className="btn btn-sm btn-primary" onClick={() => go(s)}>
                        {s.key === 'team' ? 'Пригласить' : s.key === 'project' ? 'Создать' : s.key === 'task' ? 'Поставить' : 'Настроить'}
                      </button>
                      {!s.required && !s.skipped && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => act(() => api.skipOnboardingStep(s.key))}
                          title="Отложить: шаг останется в списке, но звать к нему не будем"
                        >
                          Позже
                        </button>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ol>
            {err && <div className="error-text">{err}</div>}
          </>
        )}
      </section>

      {dialog === 'company' && (
        <CompanyStepDialog
          company={view.company}
          onClose={() => setDialog(null)}
          onSaved={(v) => { setView(v); setDialog(null); }}
        />
      )}
      {dialog === 'team' && (
        <InviteTeamDialog
          onClose={() => setDialog(null)}
          onDone={() => act(() => api.onboarding())}
        />
      )}
      {dialog === 'departments' && (
        <DepartmentsStepDialog
          industry={view.company.industry}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); act(() => api.onboarding()); }}
        />
      )}
    </>
  );
}
