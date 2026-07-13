import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { PromptRepository } from './prompt.repository';
import { PromptsService } from './prompts.service';

// Фолбэк мета-промпта, если глобальный дефолт promptops.optimize недоступен.
const FALLBACK_OPTIMIZE =
  'Ты — старший инженер промптов. По текущей инструкции ИИ-функции и её метрикам предложи улучшенную версию: ' +
  'устрани неоднозначность, задай структуру ответа, снизь риск галлюцинаций. Сохрани ВСЕ плейсхолдеры {{имя}} дословно, ' +
  'пиши на русском, не меняй суть роли. Верни СТРОГО JSON: {"improved":"<текст>","rationale":"<что изменено>"}.';

/** Толерантный разбор JSON из ответа LLM (снимает ```json-обёртку). */
function tolerantJson(raw: string): any | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(s); } catch { /* not json */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* still not */ } }
  return null;
}

/**
 * PromptOps P4: авто-оптимизация. ИИ анализирует активный промпт + его метрики и ПРЕДЛАГАЕТ
 * улучшенную версию. Авто-применения нет — владелец ревьюит и сохраняет как новую версию
 * (human-in-the-loop). Отдельный сервис, чтобы не создавать цикл AiService↔PromptsService.
 */
@Injectable()
export class PromptOptimizerService {
  constructor(
    private readonly repo: PromptRepository,
    private readonly prompts: PromptsService,
    private readonly ai: AiService,
  ) {}

  async optimize(tenantId: string, key: string, days: number) {
    const tpl = await this.repo.effectiveTemplate(tenantId, key);
    if (!tpl) throw AppException.notFound('Промпт не найден');
    const active = await this.repo.activeVersion(tpl.id);
    if (!active) throw AppException.validation('Нет активной версии для оптимизации');

    const rows = await this.repo.metricsByVersion(tpl.id, days, tenantId);
    const m = rows.find((r) => r.version === active.version) ?? { calls: 0, up: 0, down: 0, reworked: 0 };
    const vars = Array.isArray(active.variables) ? (active.variables as string[]) : [];
    const metricsText = `вызовов ${m.calls}, 👍 ${m.up}, 👎 ${m.down}, переделок ${m.reworked}`;

    // мета-промпт оптимизатора — сам версионируемый (догфудинг)
    const meta = await this.prompts.resolve(tenantId, 'promptops.optimize', {});
    const system = meta?.body ?? FALLBACK_OPTIMIZE;
    const user =
      `Функция: ${tpl.title} (${key})\n` +
      `Метрики за ${days} дн.: ${metricsText}\n` +
      `Плейсхолдеры (сохранить дословно): ${vars.length ? vars.map((v) => `{{${v}}}`).join(', ') : 'нет'}\n\n` +
      `ТЕКУЩАЯ ИНСТРУКЦИЯ:\n${active.body}`;

    const raw = await this.ai.generate(tenantId, system, user, 'promptops_optimize', {
      promptVersionId: meta?.versionId, model: meta?.model, params: meta?.params,
    });
    const parsed = tolerantJson(raw);
    const improved = typeof parsed?.improved === 'string' && parsed.improved.trim() ? parsed.improved.trim() : null;
    let rationale = typeof parsed?.rationale === 'string' ? parsed.rationale.trim() : null;

    // предупредим, если модель потеряла плейсхолдеры (владелец увидит перед сохранением)
    let warning: string | null = null;
    if (improved && vars.length) {
      const missing = vars.filter((v) => !improved.includes(`{{${v}}}`));
      if (missing.length) warning = `В предложении отсутствуют плейсхолдеры: ${missing.map((v) => `{{${v}}}`).join(', ')}`;
    }
    if (!improved && !rationale) {
      rationale = 'Не удалось получить предложение. Нужен рабочий LLM-ключ (OpenAI/Anthropic) в «Интеграции → ИИ».';
    }

    return {
      key,
      currentVersion: active.version,
      current: active.body,
      suggestion: improved,
      rationale,
      warning,
      metrics: metricsText,
      model: meta?.model ?? null,
    };
  }
}
