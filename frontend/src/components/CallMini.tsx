import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { RemoteMedia } from './CallMedia';
import { Knock } from '../lib/meet-client';
import { MiniPerson, initials, miniNote, miniOrder } from '../lib/call-mini';

/**
 * Ниже этой ширины (или высоты) окно считается крошечным.
 *
 * В такое окно четыре лица не влезают: они превращаются в марки, на которых не
 * разобрать ни человека, ни кто говорит. Показываем одного — говорящего — и убираем
 * всё, кроме кнопок: подписи в окне размером со спичечный коробок только мешают.
 */
const TINY_W = 210;
const TINY_H = 140;

/**
 * Свёрнутый созвон.
 *
 * Это не «панель с кнопками», а маленькая копия встречи: лица участников,
 * говорящий крупнее и с рамкой, снизу — микрофон, камера, возврат и выход.
 * Так свёрнутый созвон устроен в Google Meet, и ожидания у людей ровно такие.
 *
 * Живёт в двух местах и выглядит одинаково: внутри страницы (тогда его можно
 * таскать мышью) и в окне поверх всех окон, когда браузер это умеет.
 *
 * Пустого прямоугольника здесь быть не может: нет камеры — рисуем инициалы.
 * Пустой чёрный блок читается как «созвон сломался», хотя разговор идёт.
 */
export function CallMini({ people, videoOf, speaking, micOn, camOn, recording, peerCount, detached, knocks, onKnock, onMic, onCam, onExpand, onHide, onLeave }: {
  people: MiniPerson[];
  /** Дорожка участника, если камера включена. */
  videoOf: (id: string) => MediaStreamTrack | null;
  speaking: string | null;
  micOn: boolean;
  camOn: boolean;
  recording: boolean;
  peerCount: number;
  /** В окне поверх всех окон возвращаться некуда «сворачиванием» — только закрыть окно. */
  detached: boolean;
  /** Гости за дверью: свернув окно, человек не должен переставать их видеть. */
  knocks: Knock[];
  onKnock: (guestId: string, admit: boolean) => void;
  onMic: () => void;
  onCam: () => void;
  onExpand: () => void;
  /**
   * Убрать созвон с глаз совсем: разговор продолжится, вернуться — кнопкой в углу.
   * У гостя такой возможности нет: за окном созвона у него пустая страница.
   */
  onHide?: () => void;
  onLeave: () => void;
}) {
  /**
   * Насколько окно маленькое, решаем по нему самому, а не по тому, где оно живёт:
   * плашку человек тянет за угол, а окно поверх всех окон браузер открывает своего
   * размера — и в обоих случаях содержимое обязано ужаться само.
   */
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [tiny, setTiny] = useState(false);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setTiny(el.offsetWidth < TINY_W || el.offsetHeight < TINY_H);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = miniOrder(people, speaking, tiny ? 1 : undefined);

  return (
    <div className={`mini-call${detached ? ' mini-call-pip' : ''}${tiny ? ' mini-tiny' : ''}`} ref={boxRef}>
      <div className="mini-grid" data-count={shown.length}>
        {shown.map((p) => {
          const track = videoOf(p.id);
          return (
            <div
              key={p.id}
              className={`mini-tile${speaking === p.id ? ' mini-speaking' : ''}`}
              // Клик по лицу возвращает в разговор — так же, как в привычных
              // видеовстречах: целиться в маленькую кнопку не нужно.
              onDoubleClick={onExpand}
            >
              {track
                ? <RemoteMedia track={track} muted={p.isSelf} />
                : (
                  <span className="mini-avatar" aria-hidden="true">
                    {p.isAi ? <Icon name="robot" size={20} /> : initials(p.name)}
                  </span>
                )}
              <span className="mini-name">{p.isSelf ? 'вы' : p.name}</span>
            </div>
          );
        })}
      </div>

      {/* Гость стучится, пока окно свёрнуто. Показываем первого: остальные дождутся
          разворачивания, а держать человека за дверью молча нельзя. */}
      {knocks.length > 0 && (
        <div className="mini-knock">
          <span className="mini-knock-who"><Icon name="user" size={13} /> {knocks[0].name}</span>
          <button className="btn btn-sm" onClick={() => onKnock(knocks[0].guestId, true)}>Впустить</button>
          <button className="btn btn-ghost btn-sm" onClick={() => onKnock(knocks[0].guestId, false)}>Нет</button>
        </div>
      )}

      {/* Запись видна и в свёрнутом окне: тихой записи в продукте нет. В крошечном
          окне от подписи остаётся точка — место есть только под неё, но знать о
          записи человек обязан в любом размере. */}
      {recording && (
        <span className="mini-rec">
          <span className="mini-rec-dot" aria-hidden="true" />
          {!tiny && 'запись'}
        </span>
      )}
      {!tiny && <span className="mini-note">{miniNote(peerCount, recording)}</span>}

      <div className="mini-bar">
        <button
          className={`mini-btn${micOn ? '' : ' mini-btn-off'}`}
          onClick={onMic}
          title={micOn ? 'Выключить микрофон' : 'Включить микрофон'}
          aria-label={micOn ? 'Выключить микрофон' : 'Включить микрофон'}
        >
          <Icon name={micOn ? 'mic' : 'mic-off'} size={16} />
        </button>
        <button
          className={`mini-btn${camOn ? '' : ' mini-btn-off'}`}
          onClick={onCam}
          title={camOn ? 'Выключить камеру' : 'Включить камеру'}
          aria-label={camOn ? 'Выключить камеру' : 'Включить камеру'}
        >
          <Icon name={camOn ? 'video' : 'video-off'} size={16} />
        </button>
        <button
          className="mini-btn"
          onClick={onExpand}
          title={detached ? 'Вернуться в CRM — окно закроется' : 'Развернуть созвон'}
          aria-label={detached ? 'Вернуться в CRM' : 'Развернуть созвон'}
        >
          <Icon name="maximize" size={16} />
        </button>
        {/* Убрать с глаз — не то же самое, что выйти: соседняя красная кнопка кладёт
            трубку, эта только прячет окно. В отдельном окне ту же работу делает его
            собственный крестик, но искать его глазами человек не обязан. */}
        {onHide && (
          <button
            className="mini-btn"
            onClick={onHide}
            title="Убрать окно — созвон продолжится, вернуться можно кнопкой в углу"
            aria-label="Убрать окно созвона"
          >
            <Icon name="close" size={16} />
          </button>
        )}
        <button className="mini-btn mini-btn-leave" onClick={onLeave} title="Выйти из созвона" aria-label="Выйти из созвона">
          <Icon name="phone" size={16} />
        </button>
      </div>
    </div>
  );
}
