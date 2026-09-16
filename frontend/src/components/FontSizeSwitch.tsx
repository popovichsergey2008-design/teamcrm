import { useState } from 'react';
import { FONT_SIZES, BASE_SIZE, fontSize, setFontSize } from '../lib/font-scale';

/**
 * Размер шрифта интерфейса.
 *
 * Стоит в личном кабинете рядом с выбором темы — по просьбе заказчика: обе настройки
 * про то, как приложение выглядит, и искать их человек будет в одном месте.
 * Раньше размер жил в настройке меню, куда заходят за другим.
 *
 * Цифры показываем прямо своим размером: «16» крупнее «12», и выбирать можно глазами,
 * не вчитываясь в подписи.
 */
export function FontSizeSwitch() {
  const [size, setSize] = useState(fontSize);

  const pick = (px: number) => {
    setSize(px);
    setFontSize(px);
  };

  return (
    <div className="font-switch" role="group" aria-label="Размер шрифта">
      {FONT_SIZES.map((px) => (
        <button
          key={px}
          className={`font-option${px === size ? ' active' : ''}`}
          style={{ fontSize: `${px}px` }}
          onClick={() => pick(px)}
          title={px === BASE_SIZE ? 'Обычный размер' : `Шрифт ${px} точек`}
          aria-pressed={px === size}
        >
          {px}
        </button>
      ))}
    </div>
  );
}
