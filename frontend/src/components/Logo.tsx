/**
 * Знак QEVO.
 *
 * Картинка из фирменного исходника (private/TZ/QEVO.png, собирается скриптом
 * scripts/brand-assets.py): буква Q со стрелкой вверх, синий → бирюзовый градиент на
 * прозрачном фоне. Знак нарисован для светлого фона и стоит сам по себе — без плитки:
 * прежний неоновый знак требовал тёмной подложки, этот нет.
 *
 * Размеры: одна картинка 512×512 на всё. Мельче 20 пикселей знак не ставим — стрелка
 * внутри Q сливается.
 */
export function Logo({ size = 32, withWord = false }: { size?: number; withWord?: boolean }) {
  const mark = (
    <img
      className="logo-mark"
      src="/logo-mark.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );

  if (!withWord) return mark;

  return (
    <span className="logo">
      {mark}
      {/* Слово набрано текстом, а не взято из картинки: оно ищется поиском, читается
          скринридером и не мылится на любом экране. */}
      <span className="logo-word">QEVO</span>
    </span>
  );
}
