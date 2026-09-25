import { RefObject, useEffect } from 'react';
import { edgeScrollStep, isBoardDrag } from '../lib/board-dnd';

/**
 * Лента колонок едет сама, когда карточку тащат к краю экрана.
 *
 * Зачем. Колонок на доске больше, чем влезает в окно, и до дальней задачу было не
 * донести: перетаскивание работает только по видимому, а отпустить карточку и
 * прокрутить ленту рукой нельзя — перенос при этом обрывается. Нужную колонку
 * приходилось искать кнопкой «переместить» в карточке.
 *
 * Теперь достаточно подтащить карточку к правому краю — лента поедет влево и подставит
 * следующие колонки; к левому — поедет обратно.
 *
 * Почему на `document`, а не на самой ленте: к краю подтаскивают ИМЕННО за её пределы,
 * и события в этот момент приходят уже не ленте, а тому, что под указателем.
 *
 * Почему свой кадровый цикл, а не «подвинуть на каждое событие»: пока карточку держат
 * неподвижно у края, браузер шлёт `dragover` примерно трижды в секунду — лента ехала бы
 * рывками. Цикл двигает её каждый кадр, беря последнее известное место указателя, и
 * останавливается, если событий давно не было (указатель ушёл за пределы окна).
 */
export function useDragEdgeScroll(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    /*
      Ленту ищем в момент события, а не при подписке: доска приходит с сервера, и когда
      этот код выполняется первый раз, колонок на странице ещё нет. Раньше здесь стояла
      проверка «нет ленты — выходим», и подписка тихо не заводилась вовсе.
    */
    let pointerX = 0;
    let lastEvent = 0;
    let frame = 0;

    const tick = () => {
      frame = 0;
      // Событий нет почти секунду — указателя в окне уже нет, ехать некуда.
      if (performance.now() - lastEvent > 900) return;
      const el = ref.current;
      if (!el) return;

      const box = el.getBoundingClientRect();
      const step = edgeScrollStep({
        pointer: pointerX,
        start: box.left,
        end: box.right,
        scroll: el.scrollLeft,
        maxScroll: el.scrollWidth - el.clientWidth,
        // В узком окне полоса в сотню пикселей съела бы пятую часть экрана.
        zone: Math.min(96, box.width * 0.2),
      });
      if (step) el.scrollLeft += step;
      frame = requestAnimationFrame(tick);
    };

    const onOver = (e: DragEvent) => {
      if (!isBoardDrag(e.dataTransfer)) return;
      pointerX = e.clientX;
      lastEvent = performance.now();
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    document.addEventListener('dragover', onOver);
    document.addEventListener('dragend', stop);
    document.addEventListener('drop', stop);
    return () => {
      stop();
      document.removeEventListener('dragover', onOver);
      document.removeEventListener('dragend', stop);
      document.removeEventListener('drop', stop);
    };
  }, [ref, enabled]);
}
