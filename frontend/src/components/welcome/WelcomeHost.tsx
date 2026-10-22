import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../state/auth';
import { Icon } from '../Icon';
import { GuideBot } from './GuideBot';
import { CareStart, Faces } from './CareStart';
import './welcome.css';

/**
 * Первый запуск (#4620, «Сегодня» п.1 и «Старт» п.1–4): три слайда, карточка выбора
 * «Как запустим ваше рабочее пространство?», дальше — Qevo-бот (Кнопка 1) или окно
 * Отдела заботы с выбором, откуда переносим задачи (Кнопка 2).
 *
 * Тексты — дословно из документа заказчика. Один раз: «показано» ставим в
 * ui_prefs.welcome, как только человек выбрал путь или закрыл экран.
 *
 * Пока здесь что-то открыто, обучение (components/tour) ждёт: маркер data-tour-hold.
 */

type Phase = 'slides' | 'choice' | 'bot' | 'care' | 'off';

/** Слайды — дословно; заголовок и текст вместе дают фразу из документа целиком. */
const SLIDES: { icon: 'support' | 'mic' | 'zap'; title: string; text: string }[] = [
  { icon: 'support', title: 'Помощь быстрее мысли.', text: 'В Qevo живой инженер отвечает в чате за 30 секунд 24/7 — без роботов, очередей и номеров заявок' },
  { icon: 'mic', title: 'Не нужно разбираться самим.', text: 'Скажите задачу голосом за 5 секунд — мы сами создадим проекты, настроим доски, распределим роли и подключим ИИ-секретаря' },
  { icon: 'zap', title: 'Связь в 1 движение:', text: 'просто встряхните телефон или нажмите на островок Заботы, чтобы инженер подключился к вашему экрану по видео-связи Huddle за 20 секунд' },
];
/** «Три коротких слайда (10 секунд)» — по трети на слайд. */
const SLIDE_MS = 3400;

export default function WelcomeHost() {
  const { user } = useAuth();
  const [phase, setPhase] = useState<Phase>('slides');
  /** Бот уже начат: уходим к инженеру и возвращаемся — разговор на месте. */
  const [botOn, setBotOn] = useState(false);
  const saved = useRef(false);

  if (!user || user.role === 'client' || user.platformStaff) return null;

  const shown = () => {
    if (saved.current) return;
    saved.current = true;
    void api.saveUiPrefs({ welcome: { done: true } }).catch(() => undefined);
  };

  return (
    <>
      {(phase === 'slides' || phase === 'choice' || phase === 'care') && <i data-tour-hold hidden />}
      {phase === 'slides' && <Slides onDone={() => setPhase('choice')} />}
      {phase === 'choice' && (
        <Choice
          onSelf={() => { shown(); setBotOn(true); setPhase('bot'); }}
          onCare={() => { shown(); setPhase('care'); }}
          onClose={() => { shown(); setPhase('off'); }}
        />
      )}
      {botOn && (
        <GuideBot
          hidden={phase !== 'bot'}
          onEngineer={() => setPhase('care')}
          onClose={() => { setBotOn(false); setPhase('off'); }}
        />
      )}
      {phase === 'care' && (
        <CareStart
          onClose={() => setPhase(botOn ? 'bot' : 'off')}
          onSent={() => { setBotOn(false); setPhase('off'); }}
        />
      )}
    </>
  );
}

function Slides({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const touch = useRef<number | null>(null);
  const next = useRef<HTMLButtonElement | null>(null);
  const go = (to: number) => { if (to >= SLIDES.length) onDone(); else setI(Math.max(0, to)); };

  useEffect(() => {
    const t = window.setTimeout(() => go(i + 1), SLIDE_MS);
    return () => window.clearTimeout(t);
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { next.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onDone(); }
      else if (e.key === 'ArrowRight') go(i + 1);
      else if (e.key === 'ArrowLeft') go(i - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const s = SLIDES[i];
  return (
    <div className="wl-layer" role="dialog" aria-modal="true" aria-label="Знакомство с Qevo">
      <div
        className="wl-slides"
        onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
        onTouchEnd={(e) => {
          const from = touch.current;
          touch.current = null;
          if (from == null) return;
          const dx = e.changedTouches[0].clientX - from;
          if (Math.abs(dx) > 40) go(i + (dx < 0 ? 1 : -1));
        }}
      >
        <div className="wl-bars" aria-hidden="true">
          {SLIDES.map((_, k) => (
            <span key={k} className={k < i ? 'wl-bar-done' : k === i ? 'wl-bar-now' : ''}>
              <i key={`${k}-${i}`} style={{ animationDuration: `${SLIDE_MS}ms` }} />
            </span>
          ))}
        </div>
        <button className="wl-skip" onClick={onDone}>Пропустить</button>
        <div className="wl-slide" key={i} aria-live="polite">
          <span className="wl-slide-mark" aria-hidden="true"><Icon name={s.icon} size={34} /></span>
          <h2>{s.title}</h2>
          <p>{s.text}</p>
        </div>
        <div className="wl-slide-foot">
          <span className="wl-count">{i + 1}/{SLIDES.length}</span>
          <span className="wl-slide-acts">
            {i > 0 && <button className="ui-btn ui-btn-ghost ui-btn-md" onClick={() => go(i - 1)}>Назад</button>}
            <button ref={next} className="ui-btn ui-btn-primary ui-btn-md" onClick={() => go(i + 1)}>
              {i === SLIDES.length - 1 ? 'Начать' : 'Дальше'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function Choice({ onSelf, onCare, onClose }: { onSelf: () => void; onCare: () => void; onClose: () => void }) {
  const care = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { care.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="wl-layer" role="dialog" aria-modal="true" aria-labelledby="wl-choice-title">
      <div className="wl-choice">
        <button className="wl-x" onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть"><Icon name="close" size={18} /></button>
        <h2 id="wl-choice-title">Добро пожаловать в Qevo! Как запустим ваше рабочее пространство?</h2>
        <div className="wl-cards">
          {/* Кнопка 1 (обычная) */}
          <button className="wl-card wl-card-self" onClick={onSelf}>
            <span className="wl-card-mark" aria-hidden="true"><Icon name="robot" size={22} /></span>
            <b className="wl-card-title">Создам проекты и задачи сам (с умным помощником Qevo)</b>
            <span className="wl-card-text">Умный Qevo-бот задаст вам 3 быстрых вопроса, на основе ваших ответов сам соберет ваш первый проект, наглядно покажет, как ставится задача, и ответит на любые вопросы вместе с подсказками приложения</span>
          </button>
          {/* Кнопка 2 (крупная яркая: пульсирующая зелёная точка и фото дежурных) */}
          <button ref={care} className="wl-card wl-card-care" onClick={onCare}>
            <span className="wl-care-top">
              <Faces max={3} />
              <span className="wl-pulse" aria-hidden="true" />
            </span>
            <b className="wl-card-title">Настройте все за меня за 10 минут (Бесплатно)</b>
            <span className="wl-card-text">Инженер Отдела заботы подключится за 25 секунд, бесплатно перенесет ваши задачи и проекты из Trello, Jira, Notion, Excel или чатов Telegram, создаст структуру папок и поможет подключить команду</span>
          </button>
        </div>
      </div>
    </div>
  );
}
