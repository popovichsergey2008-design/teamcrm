import { Injectable } from '@nestjs/common';
import { PulseIndexRepository } from './pulse-index.repository';
import {
  COMPONENTS, COMPONENT_HINT, COMPONENT_TITLE, effectOf, formulaText, headlineOf, indexOf, IndexPoint, INDEX_VERSION,
  series, speedLine, WEIGHTS, zoneOf, ZONE_TITLE, EMPTY_POINT,
} from './pulse-index.rules';

/** Сколько недель истории берём: 8 точек графика + до 8 недель базы у самой старой. */
const HISTORY = Array.from({ length: 15 }, (_, i) => i + 1);
const HISTORY_MS = 10 * 60_000;

/**
 * Индекс здоровья команды v2 (#4890, п. 1). Прошлые недели меняются редко — кэш на
 * 10 минут; «сейчас» считается заново на каждый запрос: решение в Фокусе сразу меняет
 * индекс в Пульсе (п. 13).
 */
@Injectable()
export class PulseIndexService {
  private history = new Map<string, { at: number; points: IndexPoint[] }>();

  constructor(private readonly repo: PulseIndexRepository) {}

  private async historyOf(tenantId: string): Promise<IndexPoint[]> {
    const hit = this.history.get(tenantId);
    if (hit && Date.now() - hit.at < HISTORY_MS) return hit.points;
    const m = await this.repo.points(tenantId, HISTORY);
    const points = HISTORY.map((k) => m.get(k) ?? EMPTY_POINT);
    this.history.set(tenantId, { at: Date.now(), points });
    return points;
  }

  /** Все точки: [сейчас, неделю назад, …]. */
  async points(tenantId: string): Promise<IndexPoint[]> {
    const [now, hist] = await Promise.all([this.repo.points(tenantId, [0]), this.historyOf(tenantId)]);
    return [now.get(0) ?? EMPTY_POINT, ...hist];
  }

  /** Только число — для плашки после решения и «Пульса недели». */
  async score(tenantId: string): Promise<number> {
    const p = await this.points(tenantId);
    return indexOf(p[0], p[1] ?? null, p.slice(1, 9)).score;
  }

  async index(tenantId: string) {
    const p = await this.points(tenantId);
    const r = indexOf(p[0], p[1] ?? null, p.slice(1, 9));
    const s = series(p, 8);
    const trend7 = s.length >= 2 ? Math.round((s[s.length - 1] - s[s.length - 2]) * 10) / 10 : 0;
    const zone = zoneOf(r.score);
    return {
      score: r.score, display: Math.round(r.score), zone, zoneTitle: ZONE_TITLE[zone], version: INDEX_VERSION,
      headline: headlineOf(r), speed: speedLine(p), trend7, series: s,
      velocity: { last7: p[0].closed7, prev7: p[1]?.closed7 ?? 0 },
      metrics: p[0],
      formula: {
        text: formulaText(r),
        components: COMPONENTS.map((k) => ({
          key: k, title: COMPONENT_TITLE[k], hint: COMPONENT_HINT[k], weight: WEIGHTS[k],
          value: r.components[k], level: r.parts[k].level, dynamics: r.parts[k].dynamics, cur: r.parts[k].cur, base: r.parts[k].base,
        })),
      },
      points: p,
    };
  }

  /** «Индекс +N» по формуле, а не с потолка (п. 2, 7). */
  effect(points: IndexPoint[], delta: Partial<IndexPoint>): number { return effectOf(points, delta); }

  invalidate(tenantId: string) { this.history.delete(tenantId); }
}
