/**
 * Реестр общих ключей платформы (ТЗ консолей, §5.6). Какие ключи владелец заменяет в
 * консоли, какие пока только видит, и общий доступ к действующему значению.
 */

export type CheckKind = 'openai' | 'anthropic' | 'openrouter' | 'kimi' | 'none';

export interface SecretDef {
  /** Имя переменной .env, которую ключ заменяет. */
  name: string;
  service: string;
  purpose: string;
  check: CheckKind;
}

/** Ключи, которые сервер берёт из реестра (с запасом из .env). */
export const MANAGED: SecretDef[] = [
  { name: 'KIMI_API_KEY', service: 'Kimi (Moonshot)', purpose: 'Общий ИИ: пробный период новых компаний и площадка QEVO', check: 'kimi' },
  { name: 'OPENAI_API_KEY', service: 'OpenAI', purpose: 'Общий ИИ: пробный период, речь и эмбеддинги', check: 'openai' },
  { name: 'ANTHROPIC_API_KEY', service: 'Anthropic', purpose: 'Общий ИИ (резервный провайдер)', check: 'anthropic' },
  { name: 'OPENROUTER_API_KEY', service: 'OpenRouter', purpose: 'Общий ИИ (резервный провайдер)', check: 'openrouter' },
  { name: 'DEMO_OPENAI_API_KEY', service: 'OpenAI (демо)', purpose: 'Демо ИИ в онбординге и Telegram-боте', check: 'openai' },
  { name: 'TAVILY_API_KEY', service: 'Tavily', purpose: 'Поиск в интернете для ИИ', check: 'none' },
];

/**
 * Ключи, которые пока живут только в .env: консоль показывает, задан ли ключ и его
 * последние символы, но заменить его можно только на сервере (их читают при старте
 * почта, оплата, вход через Google, Telegram).
 */
export const ENV_ONLY: SecretDef[] = [
  { name: 'BREVO_API_KEY', service: 'Brevo', purpose: 'Почта: письма о задачах, входе и оплате', check: 'none' },
  { name: 'YOOKASSA_SECRET_KEY', service: 'ЮKassa', purpose: 'Приём оплаты подписок', check: 'none' },
  { name: 'GOOGLE_OAUTH_CLIENT_SECRET', service: 'Google OAuth', purpose: 'Вход и Google Workspace', check: 'none' },
  { name: 'TELEGRAM_BOT_TOKEN', service: 'Telegram', purpose: 'Бот: уведомления и вход', check: 'none' },
];

export const isManaged = (name: string): boolean => MANAGED.some((d) => d.name === name);

/** «…a1b2» — всё, что о значении можно показать. */
export function last4(value: string): string {
  const v = value.trim();
  return v.length <= 8 ? '…' : `…${v.slice(-4)}`;
}

/** Похоже ли на ключ: без пробелов и переводов строк, разумной длины. */
export function plausibleKey(value: string): boolean {
  const v = value.trim();
  return v.length >= 16 && v.length <= 500 && !/\s/.test(v);
}

// ── действующие значения: заполняет SharedSecretsService, читают все ──

const active = new Map<string, string>();

/** Подменить действующие значения целиком (после чтения реестра). */
export function setActiveSecrets(next: Map<string, string>): void {
  active.clear();
  for (const [k, v] of next) active.set(k, v);
}

/**
 * Действующий общий ключ: активная версия из реестра, иначе .env, как раньше.
 * Синхронно — его читают в горячих местах (выбор ключа ИИ на каждый запрос).
 */
export function sharedSecret(name: string): string | undefined {
  return active.get(name) || process.env[name]?.trim() || undefined;
}

/** Откуда сейчас берётся ключ — для консоли. */
export function sourceOf(name: string): 'registry' | 'env' | 'none' {
  if (active.get(name)) return 'registry';
  return process.env[name]?.trim() ? 'env' : 'none';
}
