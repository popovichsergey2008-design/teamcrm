import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { localParts } from '../assistant/ping-rules';
import { zonedTime } from '../focus/close-day';
import { FeedRepository } from './feed.repository';
import { FeedService } from './feed.service';
import { NewsFactsRepository } from './news-facts.repository';
import { DayFacts, highlightReason, highlightText, learningsText, pickHero, plural } from './news-rules';

const POLISH_SYSTEM = `Ты редактор корпоративной ленты. Перепиши текст живее и короче, по-русски,
без канцелярита, без пафоса и восклицательных знаков. СТРОГО сохрани все числа, имена,
названия в кавычках и смысл каждой строки. Ничего не добавляй от себя. Ответ — только текст.`;

/** Все числа текста: модель обязана их сохранить, иначе берём текст правил (§86). */
function numbersOf(text: string): string {
  return (text.match(/\d+/g) ?? []).sort().join(',');
}

/** Дата (ГГГГ-ММ-ДД) плюс n дней — без часовых поясов, по календарю. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Номер недели ISO — ключ «одни выводы на неделю». */
function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Агент «Новостей» (ТЗ-20, волны 2, 4, 5, 7): хайлайт дня, выводы недели, кандидаты
 * на вехи и релизы, закрытие опросов. Факты — из базы, текст — правилами, модель
 * только шлифует, если у организации есть ключ. Повторный запуск безопасен: каждый
 * пост защищён ключом дня/недели (`dedup_key`), кандидат — источником.
 */
@Injectable()
export class NewsAgentService {
  private readonly log = new Logger('NewsAgent');

  constructor(
    private readonly repo: FeedRepository,
    private readonly facts: NewsFactsRepository,
    private readonly feed: FeedService,
    private readonly ai: AiService,
    private readonly aiSettings: AiSettingsService,
  ) {}

  /** Один проход планировщика: по всем живым организациям, ошибка одной не мешает другим. */
  async tick(now = new Date()): Promise<void> {
    for (const p of await this.repo.duePolls()) {
      await this.feed.finishPoll(String(p.tenant_id), String(p.post_id), null).catch((e) => this.log.warn(`опрос ${p.post_id}: ${(e as Error).message}`));
    }
    const tenants = await this.facts.activeTenants();
    for (const t of tenants) {
      const tenantId = String(t.id);
      const tz = t.timezone || 'Europe/Moscow';
      try {
        const s = await this.repo.settings(tenantId);
        const local = localParts(now, tz);
        if (s.highlights_enabled && local.hour >= s.highlight_hour && local.hour < s.highlight_hour + 3) {
          await this.dailyHighlight(tenantId, tz, now, false);
        }
        const isoDow = local.dow === 0 ? 7 : local.dow;
        if (s.learnings_enabled && isoDow === s.learnings_dow && local.hour >= s.learnings_hour && local.hour < s.learnings_hour + 3) {
          await this.weeklyLearnings(tenantId, tz, now, false);
        }
        // кандидатов ищем раз в час — в первые 10 минут часа
        if (local.minute < 10) await this.detectCandidates(tenantId);
      } catch (e) {
        this.log.warn(`новости ${tenantId}: ${(e as Error).message}`);
      }
    }
  }

  // ───────────────────────── хайлайт дня ─────────────────────────

  /**
   * Хайлайт за прошлый рабочий день (§11–16). В субботу и воскресенье не выходит;
   * в понедельник охватывает пятницу и выходные. Повода нет — пропуск (решение 11.10),
   * и пропуск тоже записывается, чтобы не пересчитывать каждые пять минут.
   * `force` — кнопка «Собрать сейчас»: без проверки часа, но с тем же ключом дня.
   */
  async dailyHighlight(tenantId: string, tz: string, now = new Date(), force = false) {
    const local = localParts(now, tz);
    const isoDow = local.dow === 0 ? 7 : local.dow;
    if (!force && (isoDow === 6 || isoDow === 7)) return { status: 'weekend' as const };
    const back = isoDow === 1 ? 3 : 1;
    const fromDate = addDays(local.date, -back);
    const from = zonedTime(fromDate, '00:00', tz);
    const to = zonedTime(local.date, '00:00', tz);
    const weekFrom = zonedTime(addDays(local.date, -7), '00:00', tz);
    const prevFrom = zonedTime(addDays(local.date, -14), '00:00', tz);

    const [closed, meetings, decisions, releases, kudos, blockers, week, prevWeek, settings] = await Promise.all([
      this.facts.closedTasks(tenantId, from, to),
      this.facts.meetings(tenantId, from, to),
      this.facts.decisions(tenantId, from, to),
      this.facts.releasePosts(tenantId, from, to),
      this.facts.kudos(tenantId, from, to),
      this.facts.blockersResolved(tenantId, from, to),
      this.facts.closedCount(tenantId, weekFrom, to),
      this.facts.closedCount(tenantId, prevFrom, weekFrom),
      this.repo.settings(tenantId),
    ]);
    const closers = new Map<string, { userId: string; name: string; count: number }>();
    for (const t of closed) {
      if (!t.assignee_id || !['urgent', 'high'].includes(t.priority)) continue;
      const c = closers.get(t.assignee_id) ?? { userId: t.assignee_id, name: t.assignee_name ?? '', count: 0 };
      c.count++;
      closers.set(t.assignee_id, c);
    }
    const f: DayFacts = {
      date: fromDate,
      completedTasks: closed.length,
      projectsAffected: new Set(closed.map((t) => t.project_id)).size,
      topTasks: closed.slice(0, 3).map((t) => ({ id: t.id, title: t.title, projectId: t.project_id, projectName: t.project_name, priority: t.priority })),
      meetingsCount: meetings.count,
      meetingsMinutes: meetings.minutes,
      decisions: decisions.length,
      releases: releases.map((r) => ({ postId: r.id, title: r.title ?? r.body.slice(0, 60) })),
      kudos: kudos.map((k) => ({ toUserId: k.to_user_id, toName: k.to_name })),
      blockersResolved: blockers,
      weekClosed: week,
      prevWeekClosed: prevWeek,
      criticalClosers: [...closers.values()],
    };
    const key = `highlight:${local.date}`;
    const reason = highlightReason(f);
    if (!reason) {
      await this.feed.createSystem(tenantId, { type: 'highlight', title: 'AI-Хайлайты дня', body: '', status: 'skipped', meta: { facts: f, reason: 'no_occasion' }, dedupKey: key });
      return { status: 'skipped' as const, facts: f };
    }
    const hero = settings.hero_enabled ? pickHero(f) : null;
    const when = back === 3 ? 'В пятницу и выходные' : 'Вчера';
    const text = highlightText(f, hero, when);
    const body = await this.polish(tenantId, text.body);
    const post = await this.feed.createSystem(tenantId, {
      type: 'highlight', title: text.title, body,
      status: settings.highlights_auto ? 'published' : 'draft',
      meta: { facts: f, sources: text.sources, hero: hero ? { userId: hero.userId, name: hero.name } : null, reason },
      dedupKey: key,
    });
    return { status: post ? (settings.highlights_auto ? 'published' : 'draft') : 'exists', postId: post ? String(post.id) : null };
  }

  // ───────────────────────── выводы недели ─────────────────────────

  async weeklyLearnings(tenantId: string, tz: string, now = new Date(), force = false) {
    const local = localParts(now, tz);
    const from = zonedTime(addDays(local.date, -6), '00:00', tz);
    const to = now;
    const [decisions, meetings, releases, kudos, blockers, closed] = await Promise.all([
      this.facts.decisions(tenantId, from, to),
      this.facts.meetingList(tenantId, from, to),
      this.facts.releasePosts(tenantId, from, to),
      this.facts.kudos(tenantId, from, to),
      this.facts.blockersResolved(tenantId, from, to),
      this.facts.closedCount(tenantId, from, to),
    ]);
    const text = learningsText({
      decisions: decisions.map((d) => ({ text: d.text.slice(0, 200), path: d.chat_id ? `/chat/${d.chat_id}` : '/chat/meetings' })),
      meetings: meetings.map((m) => ({ title: m.title || 'Встреча', path: '/chat/meetings' })),
      releases: releases.map((r) => ({ title: r.title ?? r.body.slice(0, 60), path: `/news/${r.id}` })),
      blockersResolved: blockers,
      kudosCount: kudos.length,
      closedTasks: closed,
    });
    const key = `learnings:${isoWeek(local.date)}`;
    if (!text) {
      if (!force) await this.feed.createSystem(tenantId, { type: 'learnings', title: 'Выводы недели', body: '', status: 'skipped', meta: { reason: 'too_little' }, dedupKey: key });
      return { status: 'skipped' as const };
    }
    const body = await this.polish(tenantId, text.body);
    const settings = await this.repo.settings(tenantId);
    const post = await this.feed.createSystem(tenantId, {
      type: 'learnings', title: text.title, body, status: settings.highlights_auto ? 'published' : 'draft',
      meta: { sources: text.sources }, dedupKey: key,
    });
    return { status: post ? 'published' as const : 'exists' as const, postId: post ? String(post.id) : null };
  }

  // ───────────────────────── кандидаты ─────────────────────────

  /** Вехи и релизы (§26–29): находим повод, человек решает — публиковать или нет. */
  async detectCandidates(tenantId: string): Promise<number> {
    let added = 0;
    for (const m of await this.facts.milestoneCandidates(tenantId)) {
      const contributors = await this.facts.contributors(tenantId, { projectId: m.project_id });
      const day = new Date(m.last_closed).toISOString().slice(0, 10);
      const names = contributors.slice(0, 5).map((c) => c.name);
      const onTime = m.target_date ? (day <= m.target_date ? ` — точно к сроку ${m.target_date.split('-').reverse().join('.')}` : '') : '';
      const id = await this.repo.addCandidate({
        tenantId, type: 'milestone', sourceType: 'project', sourceId: `${m.project_id}:${day}`, projectId: m.project_id,
        facts: { closed: m.closed, contributors: contributors.map((c) => ({ userId: c.user_id, name: c.name })) },
        title: `Веха завершена: «${m.name}»`,
        body: `Все задачи проекта «${m.name}» закрыты${onTime}: ${m.closed} ${plural(m.closed, 'задача', 'задачи', 'задач')}.`
          + (names.length ? `\n\nАвторы: ${names.join(', ')}.` : ''),
        visibility: m.visibility === 'all' ? 'all' : 'project', confidence: 0.8,
      });
      if (id) added++;
    }
    for (const t of await this.facts.releaseTaskCandidates(tenantId)) {
      const contributors = await this.facts.contributors(tenantId, { taskIds: [t.id] });
      const id = await this.repo.addCandidate({
        tenantId, type: 'release', sourceType: 'task', sourceId: t.id, projectId: t.project_id,
        facts: { taskIds: [t.id], contributors: contributors.map((c) => ({ userId: c.user_id, name: c.name })) },
        title: `Релиз: ${t.title}`.slice(0, 200),
        body: `В проекте «${t.project_name}» вышел релиз «${t.title}».`
          + (contributors.length ? `\n\nАвторы: ${contributors.slice(0, 5).map((c) => c.name).join(', ')}.` : ''),
        visibility: t.visibility === 'all' ? 'all' : 'project', confidence: 0.9,
      });
      if (id) added++;
    }
    return added;
  }

  // ───────────────────────── модель ─────────────────────────

  /**
   * Шлифовка моделью — только при ключе ИИ у организации (или общем). Числа обязаны
   * совпасть до единого, иначе текст правил: модель не придумывает цифры (§86).
   */
  private async polish(tenantId: string, text: string): Promise<string> {
    try {
      const keys = await this.aiSettings.resolve(tenantId);
      if (keys.source === 'none') return text;
      const out = (await this.ai.generate(tenantId, POLISH_SYSTEM, text, 'news_highlight')).trim();
      if (!out || out.length < text.length * 0.4 || out.length > text.length * 1.6) return text;
      if (numbersOf(out) !== numbersOf(text)) return text;
      return out;
    } catch (e) {
      this.log.warn(`шлифовка текста ${tenantId}: ${(e as Error).message}`);
      return text;
    }
  }
}
