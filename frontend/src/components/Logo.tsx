/**
 * Знак ANTHILL.TEAM.
 *
 * Вектором, а не картинкой, по трём причинам, и каждая из них — про светлую тему:
 *
 *  1. Исходный файл — неон на чёрном. На белом фоне он превращается в чёрный
 *     прямоугольник; вырезать фон нельзя — свечение по краям всё равно останется тёмным.
 *  2. Цвета обязаны меняться вместе с темой. В тёмной знак светится по брендбуку
 *     (Electric Cyan → Neon Purple), в светлой те же цвета углублены: неон на белом
 *     не читается — он и задуман светящимся в темноте.
 *  3. Знак нужен в размерах от 18 пикселей (панель) до 64 (экран входа). Растр на этом
 *     диапазоне либо мылит, либо весит.
 *
 * Геометрия повторяет оригинал по смыслу: многогранная сеть с узлами (муравейник как
 * связи, а не как куча) и «Λ» головы внутри. Это вольная векторная реконструкция —
 * если дизайнер отдаст официальный SVG, он встанет сюда без изменений вокруг.
 */
export function Logo({ size = 32, withWord = false }: { size?: number; withWord?: boolean }) {
  const mark = (
    <svg
      className="logo-mark"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Градиент по брендбуку: cyan → violet. Идёт по диагонали, как в оригинале. */}
        <linearGradient id="anthill-stroke" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--brand-1)" />
          <stop offset="0.55" stopColor="var(--brand-2)" />
          <stop offset="1" stopColor="var(--brand-3)" />
        </linearGradient>
      </defs>

      <g stroke="url(#anthill-stroke)" strokeLinecap="round" strokeLinejoin="round">
        {/* Внешняя сеть: восьмиугольник и вписанный ромб — «связи», а не «куча» */}
        <path d="M50 6 82 20 96 50 82 80 50 94 18 80 4 50 18 20Z" strokeWidth="2" opacity=".55" />
        <path d="M50 6 96 50 50 94 4 50Z" strokeWidth="1.5" opacity=".35" />
        <path d="M18 20 82 80M82 20 18 80M50 6v88M4 50h92" strokeWidth="1" opacity=".22" />

        {/* Голова: «Λ» с усиками — главный элемент, поэтому он ярче и толще */}
        <path d="M30 74 50 34 70 74" strokeWidth="4" />
        <path d="M36 40 30 30M64 40 70 30" strokeWidth="3" />
        <path d="M42 66h16" strokeWidth="2.5" opacity=".8" />
      </g>

      {/* Узлы сети: в оригинале они светятся, здесь — плотные точки того же градиента */}
      <g fill="url(#anthill-stroke)">
        {[
          [50, 6], [82, 20], [96, 50], [82, 80], [50, 94], [18, 80], [4, 50], [18, 20],
          [30, 30], [70, 30], [30, 74], [70, 74],
        ].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="3.4" />
        ))}
      </g>
    </svg>
  );

  if (!withWord) return mark;

  return (
    <span className="logo">
      {mark}
      {/* Слово набрано текстом, а не нарисовано: оно ищется поиском, читается
          скринридером и не мылится на любом экране. */}
      <span className="logo-word">ANTHILL<span className="logo-dot">.</span>TEAM</span>
    </span>
  );
}
