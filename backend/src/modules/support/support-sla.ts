/**
 * Факт к целям Раздела 4 ТЗ-34 (#4620): «Целевые метрики (SLA) поддержки».
 *
 * Здесь только то, что лежит в базе. Чего база не знает (скорость открытия шторки,
 * число движений до помощи, доля настроек «в 1 тап без компьютера») — сюда не
 * попадает вовсе: консоль пишет «не измеряется», а не рисует правдоподобную цифру.
 */
export interface SlaRow {
  total: string;
  ai_median: string | null;
  human_median: string | null;
  huddle_median: string | null;
  huddle_count: string;
  shots: string;
  shot_convs: string;
  csat_count: string;
  csat_happy: string;
}

export interface SlaView {
  /** Окно, за которое посчитано, — 30 дней, как у сводки. */
  days: number;
  conversations: number;
  /** Медиана первого ответа помощника, секунды с десятыми: цель «до 1 секунды». */
  aiFirstSeconds: number | null;
  /** Медиана первого ответа человека, секунды. */
  humanFirstSeconds: number | null;
  /** Медиана от просьбы о созвоне до «принял», секунды. */
  huddleConnectSeconds: number | null;
  huddleCount: number;
  /** Картинки, которые прислали сами пользователи, и в скольких обращениях. */
  userScreenshots: number;
  conversationsWithScreenshots: number;
  csatCount: number;
  /** Доля оценок «Хорошо» и «Отлично» (3–4 из 4), проценты; нет оценок — null. */
  happyPercent: number | null;
}

const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function slaView(row: SlaRow | null | undefined): SlaView {
  const ai = num(row?.ai_median);
  const human = num(row?.human_median);
  const huddle = num(row?.huddle_median);
  const csatCount = Number(row?.csat_count ?? 0);
  const happy = Number(row?.csat_happy ?? 0);
  return {
    days: 30,
    conversations: Number(row?.total ?? 0),
    // десятые нужны: «0,4 с» и «1,4 с» — по разные стороны цели, а округление их склеит
    aiFirstSeconds: ai === null ? null : Math.round(Math.max(0, ai) * 10) / 10,
    humanFirstSeconds: human === null ? null : Math.round(Math.max(0, human)),
    huddleConnectSeconds: huddle === null ? null : Math.round(Math.max(0, huddle)),
    huddleCount: Number(row?.huddle_count ?? 0),
    userScreenshots: Number(row?.shots ?? 0),
    conversationsWithScreenshots: Number(row?.shot_convs ?? 0),
    csatCount,
    happyPercent: csatCount > 0 ? Math.round((happy / csatCount) * 1000) / 10 : null,
  };
}
