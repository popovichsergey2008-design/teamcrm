import { useId } from 'react';

/*
  Рисунки двух кружков в подвале панели (просьба заказчика 27.10: «сделай ярче, интереснее»).
  Обычные значки Lucide здесь не подошли: у бота подпись идёт по дуге, у службы заботы —
  гарнитура с заливкой. Цвета свои, не из темы: кружки одинаково яркие в обеих темах.
  useId — чтобы градиенты не пересекались, если панель отрисована дважды (мобильная шторка).
*/

/** QEVO Bot: светящийся робот, снизу по дуге — «QEVO BOT». */
export function BotBadgeArt({ size = 52 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}bg`} x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a855f7" />
          <stop offset=".5" stopColor="#6366f1" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
        <radialGradient id={`${id}shine`} cx="22" cy="14" r="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity=".45" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}head`} x1="0" y1="15" x2="0" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e0e7ff" />
        </linearGradient>
        <filter id={`${id}glow`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.1" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        {/* дуга для подписи: слева направо через низ, буквы встают головой к центру */}
        <path id={`${id}arc`} d="M 5.5 32 A 26.5 26.5 0 0 0 58.5 32" fill="none" />
      </defs>

      <circle cx="32" cy="32" r="31" fill={`url(#${id}bg)`} />
      <circle cx="32" cy="32" r="31" fill={`url(#${id}shine)`} />
      <circle cx="32" cy="32" r="30.25" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth="1.5" />

      {/* антенна с искрой */}
      <path d="M32 15V10.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <circle cx="32" cy="8.8" r="2.6" fill="#fde047" filter={`url(#${id}glow)`} />

      {/* уши */}
      <rect x="15" y="21.5" width="3.5" height="8" rx="1.75" fill="#c7d2fe" />
      <rect x="45.5" y="21.5" width="3.5" height="8" rx="1.75" fill="#c7d2fe" />

      {/* голова и тёмный визор */}
      <rect x="17.5" y="15" width="29" height="21" rx="8" fill={`url(#${id}head)`} />
      <rect x="21" y="18.5" width="22" height="13" rx="6.5" fill="#1e1b4b" />

      {/* глаза и улыбка светятся */}
      <g filter={`url(#${id}glow)`}>
        <ellipse cx="27.2" cy="24" rx="2.2" ry="2.6" fill="#67e8f9" />
        <ellipse cx="36.8" cy="24" rx="2.2" ry="2.6" fill="#67e8f9" />
        <path d="M28.6 28.2q3.4 2.2 6.8 0" stroke="#67e8f9" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </g>

      <text fill="#fff" fontSize="8.4" fontWeight="800" letterSpacing="1.1" fontFamily="inherit">
        <textPath href={`#${id}arc`} startOffset="50%" textAnchor="middle">QEVO BOT</textPath>
      </text>
    </svg>
  );
}

/** Служба заботы: гарнитура оператора — так поддержку узнают сразу (спасательный круг не читался). */
export function SupportArt({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 13v-1.5a8.5 8.5 0 0 1 17 0V13" />
      <rect x="2.5" y="12" width="4.5" height="6.5" rx="2" fill="currentColor" />
      <rect x="17" y="12" width="4.5" height="6.5" rx="2" fill="currentColor" />
      <path d="M19.25 18.5v.5a3 3 0 0 1-3 3H13" />
      <circle cx="12" cy="22" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
