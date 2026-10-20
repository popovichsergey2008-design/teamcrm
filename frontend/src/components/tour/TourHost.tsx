import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Route } from '../../lib/router';
import { markTourDone, stopTourAuto, takeManualTour, tourDone, tourPrefs, TOUR_START_EVENT, TourKey } from '../../lib/tour';
import { TOURS, TourStep } from './steps';
import './tour.css';

/**
 * Обучение новичка (#4605) — как в Яндекс.Вордстате: экран затемнён, нужное место
 * подсвечено, рядом карточка «что это» с «Дальше» и счётчиком «3/14».
 *
 * При первом входе — общий обзор по меню. Подсказки разделов (доска, чаты, фокус) —
 * при первом заходе в раздел: обучать всему сразу бесполезно, запоминается то, что
 * показали в момент, когда оно понадобилось. Как в играх.
 *
 * Не мешаем: пока открыто окно или идёт созвон — ждём; закрыл крестиком или Esc —
 * этот показ больше не начнётся сам; «Больше не показывать» — не начнётся ни один.
 */

const NARROW = '(max-width: 720px)';
/** Открыто что-то поверх — обучение подождёт, а не ляжет сверху. */
const BUSY = '.ui-backdrop, .modal-overlay, .drawer-overlay, .call-panel, .incoming-call';
const PAD = 6;
const GAP = 12;

type Rect = { top: number; left: number; width: number; height: number };

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
}

function findTarget(selector: string | undefined): Element | null {
  if (!selector) return null;
  for (const el of Array.from(document.querySelectorAll(selector))) if (visible(el)) return el;
  return null;
}

/** Шаги этого экрана: без чужих для телефона/компьютера. */
function stepsFor(key: TourKey, narrow: boolean): TourStep[] {
  return TOURS[key].filter((s) => s.center || (narrow ? s.mobile : s.desktop));
}

/** Какой раздел открыт — для подсказки при первом заходе. */
function sectionTour(route: Route): TourKey | null {
  if (route.section === 'projects' && route.projectId) return 'board';
  if (route.section === 'chat' && !route.view && route.chatId !== 'anthill') return 'chats';
  if (route.section === 'focus') return 'focus';
  return null;
}
const READY: Record<TourKey, string> = {
  intro: 'body',
  board: '[data-tour="board-new"], .board-header',
  chats: '.chat-list',
  focus: '.fd-page',
};

export default function TourHost({ route }: { route: Route }) {
  const [run, setRun] = useState<{ key: TourKey; steps: TourStep[]; i: number; dir: 1 | -1 } | null>(null);
  const running = useRef(false);
  running.current = !!run;

  const start = useCallback((key: TourKey) => {
    const narrow = window.matchMedia(NARROW).matches;
    // Чего на экране нет (раздел скрыт в меню, нет прав, нет карточек) — не показываем
    // вовсе, иначе счётчик «3/14» прыгал бы через пропуски.
    const steps = stepsFor(key, narrow).filter((s) => s.center || findTarget(narrow ? s.mobile : s.desktop));
    if (steps.some((s) => !s.center)) setRun({ key, steps, i: 0, dir: 1 });
  }, []);

  /*
    Запуск, когда экран свободен: окно не открыто, нужный раздел нарисован. Проверяем
    раз в секунду, а не один раз: у нового владельца сначала идут окна знакомства
    с компанией, и обучение должно начаться ПОСЛЕ них, а не потеряться.
  */
  const whenFree = useCallback((key: TourKey, ok: () => boolean) => {
    let tries = 0;
    const t = window.setInterval(() => {
      tries += 1;
      if (running.current || tries > 120 || !ok()) { if (running.current || tries > 120) window.clearInterval(t); return; }
      if (document.querySelector(BUSY) || !document.querySelector(READY[key])) return;
      window.clearInterval(t);
      start(key);
    }, 1000);
    return () => window.clearInterval(t);
  }, [start]);

  // Вручную («Обучение» в меню профиля) — сразу, даже если обучение выключено.
  useEffect(() => {
    const manual = takeManualTour();
    if (manual) start(manual);
    const on = (e: Event) => { takeManualTour(); start(((e as CustomEvent).detail as TourKey) || 'intro'); };
    window.addEventListener(TOUR_START_EVENT, on);
    return () => window.removeEventListener(TOUR_START_EVENT, on);
  }, [start]);

  // Первый вход — общий обзор.
  useEffect(() => {
    if (tourPrefs().auto === false || tourDone('intro')) return undefined;
    return whenFree('intro', () => tourPrefs().auto !== false && !tourDone('intro'));
  }, [whenFree]);

  // Первый заход в раздел — его подсказки; после общего обзора и не поверх него.
  const sectionKey = sectionTour(route);
  useEffect(() => {
    if (!sectionKey) return undefined;
    const due = () => tourPrefs().auto !== false && tourDone('intro') && !tourDone(sectionKey) && sectionTour(route) === sectionKey;
    if (!due()) return undefined;
    return whenFree(sectionKey, due);
    // route — объект, новый на каждый рендер; важно только, какой раздел
  }, [sectionKey, whenFree]); // eslint-disable-line react-hooks/exhaustive-deps

  // Закрыл — этот показ сам больше не начнётся: обучение не должно навязываться.
  const close = useCallback(() => {
    setRun((r) => { if (r) markTourDone(r.key); return null; });
  }, []);

  if (!run) return null;
  return (
    <Spotlight
      key={`${run.key}-${run.i}`}
      step={run.steps[run.i]}
      index={run.i}
      total={run.steps.length}
      dir={run.dir}
      onNext={(dir) => setRun((r) => {
        if (!r) return r;
        // назад упёрлись в пропущенный первый шаг — идём вперёд, а не стоим
        if (r.i + dir < 0) return { ...r, i: r.i + 1, dir: 1 };
        const i = r.i + dir;
        if (i >= r.steps.length) { markTourDone(r.key); return null; }
        return { ...r, i, dir };
      })}
      onClose={close}
      onStopAll={() => { stopTourAuto(); close(); }}
    />
  );
}

function Spotlight({ step, index, total, dir, onNext, onClose, onStopAll }: {
  step: TourStep; index: number; total: number; dir: 1 | -1;
  onNext: (dir: 1 | -1) => void; onClose: () => void; onStopAll: () => void;
}) {
  const narrow = window.matchMedia(NARROW).matches;
  const selector = step.center ? undefined : narrow ? step.mobile : step.desktop;
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const [cardH, setCardH] = useState(200);
  const card = useRef<HTMLDivElement | null>(null);
  const last = index === total - 1;

  // Подсвечиваемое место: ждём до 1,5 с (раздел мог ещё рисоваться), нет — шаг пропускаем.
  useEffect(() => {
    if (!selector) return undefined;
    let raf = 0;
    let shown = false;
    const began = performance.now();
    const tick = () => {
      const el = findTarget(selector);
      if (!el) {
        if (!shown && performance.now() - began > 1500) { setMissing(true); return; }
        raf = requestAnimationFrame(tick);
        return;
      }
      if (!shown) {
        shown = true;
        const r0 = el.getBoundingClientRect();
        if (r0.top < 0 || r0.bottom > window.innerHeight) el.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      const r = el.getBoundingClientRect();
      setRect((p) => (p && Math.abs(p.top - r.top) < 0.5 && Math.abs(p.left - r.left) < 0.5 && Math.abs(p.width - r.width) < 0.5 && Math.abs(p.height - r.height) < 0.5
        ? p : { top: r.top, left: r.left, width: r.width, height: r.height }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selector]);

  // Не нашлось — дальше в ту же сторону; так шаг пропадает незаметно.
  useEffect(() => { if (missing) onNext(dir); }, [missing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Высота карточки — после того как она нарисована: иначе у нижних мест (бот, служба
  // заботы) карточка, поставленная по прикидке, уезжала за край экрана.
  useLayoutEffect(() => {
    const h = card.current?.offsetHeight;
    if (h && Math.abs(h - cardH) > 1) setCardH(h);
  }, [cardH, step, rect]);
  const hasCard = !selector || !!rect;
  useEffect(() => {
    if (hasCard) card.current?.querySelector<HTMLButtonElement>('.tour-next')?.focus({ preventScroll: true });
  }, [hasCard]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); onNext(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); onNext(-1); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onNext, onClose]);

  if (selector && !rect) return <div className="tour-layer tour-wait" />;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(360, vw - 32);
  let pos: { top: number; left: number };
  const hole = rect ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 } : null;
  if (!hole) {
    pos = { top: Math.max(16, (vh - cardH) / 2), left: (vw - w) / 2 };
  } else {
    const clampX = (x: number) => Math.min(Math.max(16, x), vw - w - 16);
    const clampY = (y: number) => Math.min(Math.max(16, y), vh - cardH - 16);
    const below = hole.top + hole.height + GAP;
    const above = hole.top - GAP - cardH;
    const right = hole.left + hole.width + GAP;
    // Узкая высокая цель (пункт меню слева) — карточка справа от неё; иначе под или над.
    if (!narrow && right + w <= vw - 16 && hole.height < vh * 0.6 && hole.left < vw / 3) {
      pos = { top: clampY(hole.top + hole.height / 2 - cardH / 2), left: right };
    } else if (below + cardH <= vh - 16) {
      pos = { top: below, left: clampX(hole.left + hole.width / 2 - w / 2) };
    } else if (above >= 16) {
      pos = { top: above, left: clampX(hole.left + hole.width / 2 - w / 2) };
    } else {
      pos = { top: clampY(vh - cardH - 16), left: clampX(hole.left + hole.width / 2 - w / 2) };
    }
  }

  const text = narrow && step.mobileText ? step.mobileText : step.text;
  return (
    // Клики мимо карточки не проходят: посреди показа случайный переход сбивает всё обучение.
    <div className="tour-layer" onClick={(e) => e.stopPropagation()}>
      {hole
        ? <div className="tour-hole" style={hole} aria-hidden="true" />
        : <div className="tour-dim" aria-hidden="true" />}
      <div
        ref={card}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-text"
        style={{ top: pos.top, left: pos.left, width: w }}
      >
        <button className="tour-x" onClick={onClose} title="Закрыть обучение (Esc)" aria-label="Закрыть обучение">×</button>
        <h3 id="tour-title">{step.title}</h3>
        <p id="tour-text">{text}</p>
        <div className="tour-foot">
          <span className="tour-count" aria-label={`Шаг ${index + 1} из ${total}`}>{index + 1}/{total}</span>
          <span className="tour-acts">
            {index > 0 && <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => onNext(-1)}>Назад</button>}
            <button className="ui-btn ui-btn-primary ui-btn-sm tour-next" onClick={() => onNext(1)}>
              {last ? (index === 0 ? 'Понятно' : 'Готово') : index === 0 && step.center ? 'Начать' : 'Дальше'}
            </button>
          </span>
        </div>
        {!last && <button className="tour-off" onClick={onStopAll}>Больше не показывать обучение</button>}
        <div className="tour-bar" aria-hidden="true"><span style={{ width: `${((index + 1) / total) * 100}%` }} /></div>
      </div>
    </div>
  );
}
