import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import './care.css';
import { api, SupportConcierge } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { collectSupportContext } from '../../lib/support-context';
import {
  careShort, careTooltip, createShakeDetector, createStallDetector, screenPhrase, Stall, stallRequest, stallText,
} from '../../lib/care-rules';
import { Icon } from '../Icon';
import type { SupportOpen } from './SupportDock';
import type { PanelInfo } from './SupportPanel';

const SupportPanel = lazy(() => import('./SupportPanel'));

const initials = (n: string) => n.split(/\s+/).map((x) => x[0] ?? '').join('').slice(0, 2).toUpperCase();
const touch = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;

/** Чтение и запись своих мелочей (где стоит кружок): в приватном окне хранилища может не быть. */
function readPos(): { x: number; y: number } | null {
  try { const v = JSON.parse(localStorage.getItem('care.bubble') ?? 'null') as { x: number; y: number } | null; return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : null; }
  catch { return null; }
}
function savePos(p: { x: number; y: number }): void {
  try { localStorage.setItem('care.bubble', JSON.stringify(p)); } catch { /* не критично */ }
}

/**
 * Отдел заботы поверх приложения (ТЗ-34, #4620).
 *
 * Здесь всё, что зовёт помощь одним движением, и то, что держит её под рукой:
 * - островок «Забота 24/7 • 25 сек» (п. 4.1): на телефоне — сверху, на ПК — в углу с фото дежурных;
 * - окно — шторкой, которая сворачивается в плавающий кружок с аватаром инженера (п. 3.1);
 * - удержание кнопки помощи 1 с и встряхивание — компактная шторка с тем, что видно на экране (п. 2.1);
 * - детектор заминок: три нажатия впустую или две неудачные записи (п. 2.5, «Сегодня» 5.1);
 * - свайп вниз от верха экрана — поиск, в нём первой строкой забота (п. 2.3);
 * - прогресс инженера наружу событием `qevo:care-progress` — его берёт уведомление Android.
 */
export default function CareHub({ request }: { request: SupportOpen | null }) {
  const [open, setOpen] = useState(false);
  const [min, setMin] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [req, setReq] = useState<SupportOpen | null>(null);
  const [info, setInfo] = useState<PanelInfo | null>(null);
  const [unread, setUnread] = useState(0);
  const [care, setCare] = useState<SupportConcierge | null>(null);
  const [tip, setTip] = useState(false);
  /** Шторка «встряхнули / зажали помощь»: что видно на экране. */
  const [quick, setQuick] = useState<string | null>(null);
  const [stall, setStall] = useState<Stall | null>(null);
  const visible = open && !min;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  /** Удержание сработало — отпускание пальца уже не «тап» по кружку. */
  const heldRef = useRef(false);

  /** Открыть окно — с просьбой или без. Свёрнутое — развернуть. */
  const show = useCallback((r?: Omit<SupportOpen, 'n'>) => {
    setMounted(true);
    setOpen(true);
    setMin(false);
    setQuick(null);
    setStall(null);
    if (r) setReq({ ...r, n: Date.now() });
  }, []);

  // просьбы снаружи (меню, Ctrl+K, пустые экраны, сбой экрана)
  useEffect(() => {
    if (!request) return;
    setMounted(true); setOpen(true); setMin(false); setQuick(null); setStall(null);
    setReq(request);
  }, [request]);

  // открыли — прочитано
  useEffect(() => { if (visible) setUnread(0); }, [visible]);

  // кто дежурит и сколько ждать — для островка; раз в минуту, пока вкладку видно
  useEffect(() => {
    const load = () => { if (document.visibilityState === 'visible') api.supportConcierge().then(setCare).catch(() => undefined); };
    load();
    const t = window.setInterval(load, 60_000);
    document.addEventListener('visibilitychange', load);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', load); };
  }, []);

  /*
    Ответили, пока окно закрыто или свёрнуто: поднимаем панель в фоне — она прочитает
    разговор, — а кружку и островку добавляем бейдж.
  */
  useEffect(() => {
    const socket = getSocket();
    const wake = () => setMounted(true);
    const incoming = () => { setMounted(true); if (!visibleRef.current) setUnread((n) => n + 1); };
    const events = ['support.message.created', 'support.agent.joined', 'support.call.requested', 'support.action.proposed'];
    for (const e of events) socket.on(e, incoming);
    socket.on('support.progress', wake);
    return () => { for (const e of events) socket.off(e, incoming); socket.off('support.progress', wake); };
  }, []);

  // прогресс инженера — наружу: уведомление Android (этап D) слушает это событие
  const progressKey = info?.progress ? `${info.progress.percent}|${info.progress.text}|${info.progress.minutesLeft}|${info.progress.engineer}` : '';
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('qevo:care-progress', { detail: info?.progress ?? null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressKey]);

  // ── шторка «Сказать голосом, созвон или написать» (п. 2.1) ──
  const openQuick = useCallback(() => {
    if (visibleRef.current) return;
    // свёрнутый разговор остаётся свёрнутым: шторка — поверх, кружок прячем, пока она открыта
    const c = collectSupportContext();
    setQuick(screenPhrase(c.entityType, c.entityId, c.telemetry?.entityTitle, c.route));
  }, []);

  // удержание кнопки помощи 1 секунду — островок, кружок, строка в меню
  useEffect(() => {
    let timer = 0;
    let fired = false;
    const down = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-care-hold]');
      if (!el) return;
      fired = false;
      heldRef.current = false;
      timer = window.setTimeout(() => { fired = true; heldRef.current = true; openQuick(); }, 1000);
    };
    const cancel = () => window.clearTimeout(timer);
    const click = (e: MouseEvent) => {
      if (!fired) return;
      fired = false;
      if ((e.target as HTMLElement | null)?.closest?.('[data-care-hold]')) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', cancel, true);
    window.addEventListener('pointercancel', cancel, true);
    const move = (e: PointerEvent) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 8) cancel(); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('click', click, true);
    return () => {
      cancel();
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', cancel, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('click', click, true);
    };
  }, [openQuick]);

  // встряхнуть телефон — та же шторка
  useEffect(() => {
    if (!touch() || typeof DeviceMotionEvent === 'undefined') return undefined;
    const d = createShakeDetector();
    const on = (e: DeviceMotionEvent) => {
      const a = e.acceleration?.x != null ? e.acceleration : e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      if (d.sample(a.x, a.y, a.z, !(e.acceleration?.x != null), Date.now())) openQuick();
    };
    window.addEventListener('devicemotion', on);
    return () => window.removeEventListener('devicemotion', on);
  }, [openQuick]);

  // свайп вниз от верха экрана — поиск (п. 2.3, 4.2)
  useEffect(() => {
    if (!touch()) return undefined;
    let start: { x: number; y: number } | null = null;
    const ts = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t && e.touches.length === 1 && t.clientY < 48 ? { x: t.clientX, y: t.clientY } : null;
    };
    const tm = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      if (t.clientY - start.y > 70 && Math.abs(t.clientX - start.x) < 60) {
        start = null;
        window.dispatchEvent(new Event('qevo:palette-open'));
      }
    };
    window.addEventListener('touchstart', ts, { passive: true });
    window.addEventListener('touchmove', tm, { passive: true });
    return () => { window.removeEventListener('touchstart', ts); window.removeEventListener('touchmove', tm); };
  }, []);

  // ── детектор заминок (п. 2.5, «Сегодня» 5.1) ──
  const detector = useRef(createStallDetector());
  useEffect(() => {
    let changes = 0;
    const mo = new MutationObserver((list) => {
      // свои перерисовки (островок, кружок) не считаем «экран отозвался»
      if (list.some((m) => !(m.target as Element).closest?.('.care-root'))) changes++;
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const ids = new WeakMap<Element, number>();
    let seq = 0;
    let last: { el: Element; changes: number } | null = null;
    const down = (e: PointerEvent) => {
      const at = document.elementFromPoint(e.clientX, e.clientY) ?? (e.target as Element | null);
      const el = at?.closest?.('button, [role="button"], a[href], input[type="submit"], .ui-btn');
      if (!el || el.closest('.care-root, .support-dock, .palette-overlay')) { last = null; return; }
      if (!ids.has(el)) ids.set(el, ++seq);
      const disabled = (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
      // «впустую» — неактивная кнопка или с прошлого нажатия на экране ничего не поменялось
      const dead = disabled || !last || last.el !== el || last.changes === changes;
      last = { el, changes };
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const s = detector.current.tap(String(ids.get(el)), label, dead, Date.now());
      if (s && !visibleRef.current) setStall(s);
    };
    const failed = (e: Event) => {
      const d = (e as CustomEvent<{ method: string; path: string; status: number }>).detail;
      if (!d || /\/support\//.test(d.path)) return;
      const s = detector.current.fail(d.method, d.path, d.status, Date.now());
      if (s && !visibleRef.current) setStall(s);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('qevo:api-failed', failed);
    return () => { mo.disconnect(); window.removeEventListener('pointerdown', down, true); window.removeEventListener('qevo:api-failed', failed); };
  }, []);

  // ── кружок (PiP): перетаскивается, тап — развернуть ──
  const [pos, setPos] = useState<{ x: number; y: number } | null>(readPos);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const bubbleDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const bubbleMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
    d.moved = true;
    const size = 60;
    setPos({
      x: Math.min(window.innerWidth - size - 4, Math.max(4, d.ox + dx)),
      y: Math.min(window.innerHeight - size - 4, Math.max(4, d.oy + dy)),
    });
  };
  const bubbleUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved) { if (pos) savePos(pos); return; }
    if (heldRef.current) { heldRef.current = false; return; }
    show();
  };

  const engineers = care?.engineers ?? [];
  const onDuty = engineers.filter((e) => e.status !== 'offline');
  const time = careShort(care?.estimate ?? null, care?.medianSec);
  const live = care?.estimate.kind === 'now' || care?.estimate.kind === 'queue';
  const lead = engineers[0];
  const tipText = careTooltip(care?.medianSec);
  const agentName = info?.agent ?? null;
  const face = agentName ? engineers.find((e) => e.name === agentName) ?? null : lead ?? null;
  const progress = info?.progress ?? null;

  const tapPill = () => {
    // касание на телефоне — подсказка всплывает и держится, окно открывается рядом
    if (touch()) { setTip(true); window.setTimeout(() => setTip(false), 2600); }
    show();
  };

  return (
    <div className="care-root">
      {/* Островок заботы (п. 2.2, 4.1) */}
      {!open && !quick && (
        <button
          type="button"
          className={`care-pill${tip ? ' tip' : ''}`}
          data-care-hold=""
          onClick={tapPill}
          aria-label={`Забота 24/7${time ? ` • ${time}` : ''}. ${tipText}`}
          aria-describedby="care-tip"
        >
          <span className="care-pill-faces" aria-hidden="true">
            {onDuty.slice(0, 3).map((e) => (
              <span key={e.userId} className="care-face">{e.avatarUrl ? <img src={e.avatarUrl} alt="" /> : initials(e.name)}</span>
            ))}
          </span>
          <span className="care-pill-shield" aria-hidden="true"><Icon name="shield" size={15} /></span>
          <span className={`care-dot${live ? ' live' : ''}`} aria-hidden="true" />
          <span className="care-pill-text">Забота 24/7{time ? ` • ${time}` : ''}</span>
          {unread > 0 && <span className="care-badge">{unread > 9 ? '9+' : unread}</span>}
          <span id="care-tip" role="tooltip" className="care-tip">{tipText}</span>
        </button>
      )}

      {/* Свёрнутое окно — кружок с аватаром инженера (п. 3.1) */}
      {open && min && !quick && (
        <button
          type="button"
          className="care-bubble"
          data-care-hold=""
          style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
          onPointerDown={bubbleDown}
          onPointerMove={bubbleMove}
          onPointerUp={bubbleUp}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); } }}
          aria-label={`Развернуть окно заботы${unread ? `, новых сообщений: ${unread}` : ''}${progress ? `. Готово ${progress.percent}%` : ''}`}
          title={progress ? `${progress.percent}% · ${progress.text}` : 'Развернуть'}
        >
          <span
            className={`care-bubble-ring${progress ? ' on' : ''}`}
            style={progress ? { ['--p' as string]: `${progress.percent}%` } : undefined}
            aria-hidden="true"
          >
            <span className="care-bubble-face">
              {face?.avatarUrl ? <img src={face.avatarUrl} alt="" /> : agentName ? initials(agentName) : face ? initials(face.name) : <Icon name="support" size={22} />}
            </span>
          </span>
          {progress && <span className="care-bubble-pct" aria-hidden="true">{progress.percent}%</span>}
          {unread > 0 && <span className="care-badge">{unread > 9 ? '9+' : unread}</span>}
        </button>
      )}

      {/* Shake-to-Help (п. 2.1): что видно на экране — и три пути */}
      {quick && (
        <div className="care-sheet" role="dialog" aria-label="Помощь Отдела заботы">
          <div className="care-sheet-head">
            <Icon name="zap" size={16} />
            <b>Отдел заботы Qevo</b>
            <button type="button" className="msg-icon" onClick={() => setQuick(null)} aria-label="Закрыть"><Icon name="close" size={15} /></button>
          </div>
          <p className="care-sheet-text">
            {quick} Сказать голосом, включить созвон с инженером ({careShort({ kind: 'now', minutes: null }, care?.medianSec)}) или написать?
          </p>
          <div className="care-sheet-acts">
            <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => show({ voice: true })}><Icon name="mic" size={14} /> Сказать голосом</button>
            <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => show({ call: true })}><Icon name="video" size={14} /> Включить созвон</button>
            <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => show()}><Icon name="chat" size={14} /> Написать</button>
          </div>
          <span className="dim care-sheet-note"><Icon name="info" size={12} /> Слепок экрана приложим сами — скриншоты не нужны</span>
        </div>
      )}

      {/* Заминка (п. 2.5, «Сегодня» 5.1): мягкая карточка снизу с фото дежурного */}
      {stall && !quick && !visible && (
        <div className="care-stall" role="dialog" aria-label="Отдел заботы предлагает помощь">
          <span className="care-face care-face-lg" aria-hidden="true">
            {lead?.avatarUrl ? <img src={lead.avatarUrl} alt="" /> : lead ? initials(lead.name) : <Icon name="support" size={20} />}
          </span>
          <div className="care-stall-body">
            <p>{stallText(stall, lead?.name ?? null)}</p>
            <div className="care-sheet-acts">
              <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => show({ text: stallRequest(stall) })}>Да, сделай за меня</button>
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setStall(null)}>Спасибо, я сам</button>
            </div>
          </div>
        </div>
      )}

      {mounted && (
        <Suspense fallback={null}>
          <SupportPanel
            request={req}
            open={open}
            onOpenChange={(v) => { setOpen(v); if (!v) setMin(false); }}
            minimized={min}
            onMinimize={() => setMin(true)}
            onInfo={setInfo}
          />
        </Suspense>
      )}
    </div>
  );
}
