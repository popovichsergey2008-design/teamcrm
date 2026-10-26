import { useEffect, useRef, type MouseEvent } from 'react';

/**
 * Закрытие окна щелчком по затемнению — но не по случайности.
 *
 * Раньше на подложке висел обычный `onClick`, и она закрывала окно всякий раз, когда
 * щелчок ЗАКАНЧИВАЛСЯ на ней. Самый частый случай — выделение текста: человек
 * начинает выделять внутри карточки, ведёт мышь и отпускает кнопку за её краем.
 * Браузер считает это щелчком по подложке, и карточка захлопывалась вместе с
 * недописанным текстом. То же самое при перетаскивании ползунков и файлов.
 *
 * Теперь закрываем, только если нажатие И отпускание пришлись на саму подложку.
 * Состояние держим в модуле, а не в замыкании: между нажатием и отпусканием
 * компонент успевает перерисоваться, и замыкание к этому моменту уже другое.
 * Мышь у человека одна, поэтому одного значения на всё приложение достаточно.
 */
let armedOn: EventTarget | null = null;

export function overlayProps(onClose: () => void) {
  return {
    onMouseDown: (e: MouseEvent) => {
      armedOn = e.target === e.currentTarget ? e.currentTarget : null;
    },
    onClick: (e: MouseEvent) => {
      const ok = e.target === e.currentTarget && armedOn === e.currentTarget;
      armedOn = null;
      if (ok) onClose();
    },
  };
}

/**
 * Закрыть слой системной кнопкой «Назад» (#4667).
 *
 * В приложении Android «Назад» листает историю WebView: своего обработчика у нас нет,
 * и оболочка Capacitor сама делает шаг назад, пока он есть. Поэтому слой при открытии
 * кладёт в историю свою запись (тот же адрес), а шаг назад с неё — это закрытие слоя,
 * а не уход с экрана, на котором слой открыли. Закрыли слой иначе (крестиком, по фону) —
 * убираем свою запись сами, чтобы следующее «Назад» не тратилось впустую.
 *
 * Запись кладём на следующем такте: в StrictMode эффект монтируется дважды, и
 * синхронный шаг назад из первой очистки снял бы уже вторую запись.
 */
export function useBackClose(onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const key = `layer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let pushed = false;
    let popped = false;
    const onPop = () => {
      // вернулись на свою запись — закрылся слой поверх нашего, нас это не касается
      if ((window.history.state as { qevoLayer?: string } | null)?.qevoLayer === key) return;
      popped = true;
      close.current();
    };
    const t = window.setTimeout(() => {
      window.history.pushState({ ...(window.history.state ?? {}), qevoLayer: key }, '');
      pushed = true;
      window.addEventListener('popstate', onPop);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('popstate', onPop);
      // ушли с экрана переходом — запись уже не наша вершина, историю не трогаем
      if (pushed && !popped && (window.history.state as { qevoLayer?: string } | null)?.qevoLayer === key) window.history.back();
    };
  }, []);
}
