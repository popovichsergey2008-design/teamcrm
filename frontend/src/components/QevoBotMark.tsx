import { useId } from 'react';

/**
 * Знак «QEVO Bot + помощь» (#4877): яркий круг в цветах QEVO (синий → бирюзовый),
 * белый робот-помощник и красное сердечко заботы на антенне — бот и служба
 * заботы в одном знаке. Нарисован сам, без плитки: стоит на любом фоне.
 *
 * Градиент — со своим id на каждый знак: два знака на странице с общим id
 * в Safari теряют заливку у второго.
 */
export function QevoBotMark({ size = 24, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      className={`qevo-bot-mark${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`qb${id}`} x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3b82ff" />
          <stop offset="1" stopColor="#14c3a8" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill={`url(#qb${id})`} />
      {/* антенна с сердечком — «помощь» */}
      <path d="M16 8.4V11" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M16 8.6C13 6.6 12.3 4.2 14 3.3c1-.5 1.7 0 2 .7.3-.7 1-1.2 2-.7 1.7.9 1 3.3-2 5.3Z"
        fill="#ff4d6d"
        stroke="#fff"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* голова */}
      <rect x="6.2" y="15.4" width="2" height="4.6" rx="1" fill="#fff" opacity=".85" />
      <rect x="23.8" y="15.4" width="2" height="4.6" rx="1" fill="#fff" opacity=".85" />
      <rect x="8.4" y="11" width="15.2" height="13.4" rx="5" fill="#fff" />
      <circle cx="13" cy="16.6" r="1.7" fill="#1d4ed8" />
      <circle cx="19" cy="16.6" r="1.7" fill="#1d4ed8" />
      <path d="M13.2 20.2c1.6 1.4 4 1.4 5.6 0" stroke="#1d4ed8" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}
