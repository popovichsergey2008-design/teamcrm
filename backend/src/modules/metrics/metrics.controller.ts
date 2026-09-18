import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/auth/decorators';
import { DbService } from '../../database/db.service';
import { AiGateway } from '../ai/ai-gateway';

/**
 * Метрики для Prometheus (05_SCALING §18–§19).
 *
 * Зачем свой формат вместо библиотеки: все наши цифры — это МГНОВЕННЫЕ значения,
 * которые считаются запросом в базу в момент опроса (длина очереди, самое старое
 * ожидание, медианы). Счётчиков, живущих в памяти процесса, здесь нет и быть не может:
 * приложение работает в двух цветах и переезжает при каждой выкладке, а счётчик в
 * памяти после переезда начинается с нуля и врёт. Ради десятка строк текста тянуть
 * зависимость незачем.
 *
 * Доступ: ручка публичная, но живёт ВНЕ префикса `/api`, а наружный nginx проксирует в
 * приложение только `/api/`, `/socket.io/` и `/ws/meet`. Значит снаружи её нет — она
 * доступна только изнутри docker-сети, где и стоит Prometheus. Проверять токен здесь
 * значит завести ещё один секрет ради двери, которой нет.
 *
 * Отвечаем через `res` напрямую, в обход общего конверта `{ok, data}`: для приложения
 * конверт правильный, но Prometheus ждёт голый текст и в конверте не разбирает ни одной
 * метрики — он видит одну строку с экранированными переносами.
 */
@ApiExcludeController()
@Controller()
export class MetricsController {
  constructor(
    private readonly db: DbService,
    private readonly gateway: AiGateway,
  ) {}

  @Public()
  @Get('/metrics')
  async metrics(@Res() res: Response): Promise<void> {
    const s = await this.db.one<{
      open: string; queued: string; unassigned: string; oldest: string | null;
      engineer: string; fixing: string; waiting_user: string;
      first_median: string | null; queue_median: string | null; reopened: string | null;
    }>(`
      SELECT COUNT(*) FILTER (WHERE closed_at IS NULL)::text AS open,
             COUNT(*) FILTER (WHERE closed_at IS NULL AND status = 'waiting_agent')::text AS queued,
             COUNT(*) FILTER (WHERE closed_at IS NULL AND assigned_agent_id IS NULL AND status <> 'ai')::text AS unassigned,
             COALESCE(MAX(EXTRACT(EPOCH FROM (now() - queued_at)))
               FILTER (WHERE closed_at IS NULL AND assigned_agent_id IS NULL), 0)::text AS oldest,
             COUNT(*) FILTER (WHERE closed_at IS NULL AND status = 'engineer_escalated')::text AS engineer,
             COUNT(*) FILTER (WHERE closed_at IS NULL AND status = 'fix_in_progress')::text AS fixing,
             COUNT(*) FILTER (WHERE closed_at IS NULL AND status = 'waiting_user')::text AS waiting_user,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (human_first_response_at - created_at))
             ) FILTER (WHERE human_first_response_at IS NOT NULL
                         AND created_at > now() - interval '7 days')::text AS first_median,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (assigned_at - queued_at))
             ) FILTER (WHERE assigned_at IS NOT NULL AND queued_at IS NOT NULL
                         AND created_at > now() - interval '7 days')::text AS queue_median,
             COUNT(*) FILTER (WHERE reopens > 0 AND created_at > now() - interval '7 days')::text AS reopened
        FROM support_conversations
    `);

    const ai = this.gateway.stats();
    const num = (v: string | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

    /*
      Формат Prometheus руками: имя, HELP, TYPE, значение.

      Единицы — в имени метрики (`_seconds`, `_total`), как принято: иначе через полгода
      никто не вспомнит, секунды это или минуты, и график будет врать молча.
    */
    const lines: string[] = [];
    const gauge = (name: string, help: string, value: number) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
    };

    gauge('support_conversations_open', 'Открытых обращений сейчас', num(s?.open));
    gauge('support_queue_length', 'Ждут свободного специалиста', num(s?.queued));
    gauge('support_unassigned', 'Обращений без исполнителя', num(s?.unassigned));
    gauge('support_queue_oldest_seconds', 'Самое долгое ожидание в очереди', Math.round(num(s?.oldest)));
    gauge('support_engineer_escalated', 'Обращений у инженеров', num(s?.engineer));
    gauge('support_fix_in_progress', 'Обращений в стадии исправления', num(s?.fixing));
    gauge('support_waiting_user', 'Ждут подтверждения от человека', num(s?.waiting_user));
    gauge('support_first_response_seconds', 'Медиана первого ответа человека за неделю', Math.round(num(s?.first_median)));
    gauge('support_queue_wait_seconds', 'Медиана ожидания в очереди за неделю', Math.round(num(s?.queue_median)));
    gauge('support_reopened_week', 'Обращений, открытых заново, за неделю', num(s?.reopened));
    gauge('ai_requests_inflight', 'Обращений к модели прямо сейчас', ai.inflight);
    gauge('ai_requests_waiting', 'Обращений к модели в очереди', ai.waiting);
    gauge('ai_requests_shed', 'Фоновых обращений к модели отложено с момента запуска', ai.shed);

    res
      .status(200)
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(`${lines.join('\n')}\n`);
  }
}
