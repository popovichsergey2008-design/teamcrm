import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { localParts } from '../assistant/ping-rules';
import { zonedTime } from '../focus/close-day';
import { FeedRepository } from './feed.repository';
import { FeedService } from './feed.service';
import { NewsFactsRepository } from './news-facts.repository';
import {
  DayFacts, HIGHLIGHT_TITLE, highlightReason, highlightText, learningsText, pickHero, plural, RADAR_MIN_TASKS, RADAR_TAG, radarText,
} from './news-rules';

const RADAR_SYSTEM = `Ты пишешь раздел «Что нового» для ленты новостей компании. На входе — закрытые задачи
(название и описание). Для КАЖДОЙ задачи напиши одну строку по-русски: что теперь появилось или
работает иначе — для коллег-неспециалистов, 5–15 слов, без канцелярита, без номеров задач и без
чисел, которых нет во входе. Не выдумывай того, чего нет в задаче. Порядок — как во входе.
Ответ — только JSON: {"items": ["…", "…"]}`;

const INSIGHTS_SYSTEM = `Ты готовишь «Главные инсайты и выводы недели» для всей команды по итогам созвонов.
На входе — встречи недели: номер, название, краткое содержание и решения. Выдели 2–4 самых важных
вывода и одно лучшее решение недели. Каждый пункт — одна фраза по-русски, 6–20 слов, живо и без
пафоса, ТОЛЬКО из входа: ничего не добавляй, числа — только те, что есть во входе. У каждого пункта
укажи номер встречи-источника. Ответ — только JSON:
{"insights": [{"text": "…", "meeting": 1}], "best": {"text": "…", "meeting": 2}}`;

const POLISH_SYSTEM =`Ты редактор корпоративной ленты. Перепиши текст живее и короче, по-русски,
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
          // релиз-радар — первым: хайлайт сошлётся на вышедшие релизы как на «главный прорыв»
          await this.releaseRadar(tenantId, tz, now).catch((e) => this.log.warn(`релиз-радар ${tenantId}: ${(e as Error).message}`));
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
    /*
      #1578: хайлайт за этот день уже есть — ничего не пересобираем. Раньше планировщик
      каждые 5 минут своего трёхчасового окна заново считал факты, звал модель на
      шлифовку и пытался вставить пост ещё раз — вставку гасил ключ дня, но модель
      работала вхолостую 36 раз за утро, а номера постов улетали на сотни вперёд.
    */
    const key = `highlight:${local.date}`;
    if (await this.repo.hasPost(tenantId, key)) return { status: 'exists' as const, postId: null };
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
      // релизы — включая вышедшие сегодня утром: радар публикуется перед хайлайтом
      this.facts.releasePosts(tenantId, from, now),
      this.facts.kudos(tenantId, from, to),
      this.facts.blockersResolved(tenantId, from, to),
      this.facts.closedCount(tenantId, weekFrom, to),
      this.facts.closedCount(tenantId, prevFrom, weekFrom),
      this.repo.settings(tenantId),
    ]);
    const closers = new Map<string, { userId: string; name: string; count: number }>();
    // все закрывшие (#1526): явный лидер дня — тоже герой; первой идёт самая важная задача
    const everyone = new Map<string, { userId: string; name: string; count: number; topTitle: string }>();
    for (const t of closed) {
      if (!t.assignee_id) continue;
      const e = everyone.get(t.assignee_id) ?? { userId: t.assignee_id, name: t.assignee_name ?? '', count: 0, topTitle: t.title };
      e.count++;
      everyone.set(t.assignee_id, e);
      if (!['urgent', 'high'].includes(t.priority)) continue;
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
      closers: [...everyone.values()],
    };
    const reason = highlightReason(f);
    if (!reason) {
      await this.feed.createSystem(tenantId, { type: 'highlight', title: HIGHLIGHT_TITLE, body: '', status: 'skipped', meta: { facts: f, reason: 'no_occasion' }, dedupKey: key });
      return { status: 'skipped' as const, facts: f };
    }
    const hero = settings.hero_enabled ? pickHero(f) : null;
    const when = back === 3 ? 'В пятницу и выходные' : 'Вчера';
    const text = highlightText(f, hero, when);
    const body = await this.polish(tenantId, text.body);
    const post = await this.feed.createSystem(tenantId, {
      type: 'highlight', title: text.title, body,
      status: settings.highlights_auto ? 'published' : 'draft',
      meta: { facts: f, sources: text.sources, hero: hero ? { userId: hero.userId, name: hero.name, why: hero.why } : null, reason },
      dedupKey: key,
    });
    return { status: post ? (settings.highlights_auto ? 'published' : 'draft') : 'exists', postId: post ? String(post.id) : null };
  }

  // ───────────────────────── релиз-радар ─────────────────────────

  /**
   * «Что нового» по проектам за прошлый рабочий день (#1526, блок 3). Повод — закрытые
   * задачи с тегом изменения продукта (программная, дизайнерская, релиз, веха): рутина
   * вроде «выложить тексты» сюда не попадает. Пункты модель переписывает человеческим
   * языком, авторы — исполнители, демонстрация — картинка или видео из задачи.
   * Один пост на проект в день (ключ), при «Публиковать сами» — сразу в ленту.
   */
  async releaseRadar(tenantId: string, tz: string, now = new Date()): Promise<number> {
    const local = localParts(now, tz);
    const isoDow = local.dow === 0 ? 7 : local.dow;
    if (isoDow === 6 || isoDow === 7) return 0;
    const back = isoDow === 1 ? 3 : 1;
    const from = zonedTime(addDays(local.date, -back), '00:00', tz);
    const to = zonedTime(local.date, '00:00', tz);
    const rows = await this.facts.featureTasks(tenantId, from, to, RADAR_TAG.source);
    const byProject = new Map<string, typeof rows>();
    for (const r of rows) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r]);
    const settings = await this.repo.settings(tenantId);
    let made = 0;
    for (const [projectId, tasks] of byProject) {
      if (tasks.length < RADAR_MIN_TASKS) continue;
      const key = `radar:${projectId}:${local.date}`;
      if (await this.repo.hasPost(tenantId, key)) continue;
      const contributors = await this.facts.contributors(tenantId, { taskIds: tasks.map((t) => t.id) });
      const authors = contributors.slice(0, 5).map((c) => c.name);
      const items = await this.radarItems(tenantId, tasks.map((t) => ({ id: t.id, title: t.title, description: t.description, assigneeName: t.assignee_name })));
      const text = radarText(tasks[0].project_name, tasks.map((t) => ({ id: t.id, title: t.title, description: t.description, assigneeName: t.assignee_name })), authors, items ?? undefined);
      const media = tasks.map((t) => t.media_file_id).filter((x): x is string => !!x).slice(0, 1);
      const post = await this.feed.createSystem(tenantId, {
        type: 'release', title: text.title, body: text.body,
        status: settings.highlights_auto ? 'published' : 'draft',
        visibility: tasks[0].visibility === 'all' ? 'all' : 'project', projectId,
        meta: {
          taskIds: tasks.map((t) => t.id),
          contributors: contributors.map((c) => ({ userId: c.user_id, name: c.name })),
          sources: tasks.slice(0, 4).map((t) => ({ label: t.title, path: `/projects/${projectId}/task/${t.id}` })),
          radar: true,
        },
        dedupKey: key, fileIds: media,
      });
      if (post) made++;
    }
    return made;
  }

  /**
   * Пункты «Что нового» человеческим языком: по одному на задачу, без новых чисел.
   * Модель недоступна или ответила не по форме — пункты остаются названиями задач.
   */
  private async radarItems(tenantId: string, tasks: { id: string; title: string; description: string | null }[]): Promise<string[] | null> {
    try {
      const keys = await this.aiSettings.resolve(tenantId);
      if (keys.source === 'none') return null;
      const input = tasks.slice(0, 6).map((t, i) => ({ n: i + 1, title: t.title, about: (t.description ?? '').slice(0, 300) }));
      const raw = await this.ai.generate(tenantId, RADAR_SYSTEM, JSON.stringify(input), 'news_highlight');
      const parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
      const items = Array.isArray(parsed?.items) ? parsed.items.map((x: unknown) => String(x ?? '').trim()).filter(Boolean) : [];
      if (items.length !== input.length) return null;
      const src = numbersOf(input.map((t) => `${t.title} ${t.about}`).join(' ')).split(',');
      // число, которого нет в задачах, — выдумка: берём названия
      if (items.some((s: string) => (s.match(/\d+/g) ?? []).some((n) => !src.includes(n)) || s.length > 220)) return null;
      return items;
    } catch (e) {
      this.log.warn(`релиз-радар без модели ${tenantId}: ${(e as Error).message}`);
      return null;
    }
  }

  // ───────────────────────── выводы недели ─────────────────────────

  async weeklyLearnings(tenantId: string, tz: string, now = new Date(), force = false) {
    const local = localParts(now, tz);
    // #1578: одни выводы на неделю — уже вышли (или пропущены), повторно не собираем
    const key = `learnings:${isoWeek(local.date)}`;
    if (await this.repo.hasPost(tenantId, key)) return { status: 'exists' as const, postId: null };
    const from = zonedTime(addDays(local.date, -6), '00:00', tz);
    const to = now;
    const [decisions, meetings, releases, kudos, blockers, closed, summaries] = await Promise.all([
      this.facts.decisions(tenantId, from, to),
      this.facts.meetingList(tenantId, from, to),
      this.facts.releasePosts(tenantId, from, to),
      this.facts.kudos(tenantId, from, to),
      this.facts.blockersResolved(tenantId, from, to),
      this.facts.closedCount(tenantId, from, to),
      this.facts.meetingSummaries(tenantId, from, to),
    ]);
    const ins = await this.insights(tenantId, summaries);
    const text = learningsText({
      insights: ins?.insights,
      best: ins?.best ?? null,
      decisions: decisions.map((d) => ({ text: d.text.slice(0, 200), path: d.chat_id ? `/chat/${d.chat_id}` : '/chat/meetings' })),
      meetings: meetings.map((m) => ({ title: m.title || 'Встреча', path: '/chat/meetings' })),
      releases: releases.map((r) => ({ title: r.title ?? r.body.slice(0, 60), path: `/news/${r.id}` })),
      blockersResolved: blockers,
      kudosCount: kudos.length,
      closedTasks: closed,
    });
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

  /**
   * Выводы из итогов созвонов (#1526, блок 5). Модель читает краткие содержания и
   * решения встреч недели; каждый вывод привязан к своей встрече (ссылка-источник),
   * число, которого нет во входе, — повод выбросить ответ и остаться на правилах.
   */
  private async insights(tenantId: string, rows: { id: string; title: string | null; summary: string; decisions: unknown }[]) {
    if (!rows.length) return null;
    try {
      const keys = await this.aiSettings.resolve(tenantId);
      if (keys.source === 'none') return null;
      const input = rows.map((m, i) => ({
        n: i + 1, title: m.title ?? 'Встреча', summary: m.summary.slice(0, 1200),
        decisions: (Array.isArray(m.decisions) ? m.decisions : []).slice(0, 6).map((d: any) => String(d?.text ?? d ?? '')).filter(Boolean),
      }));
      const raw = await this.ai.generate(tenantId, INSIGHTS_SYSTEM, JSON.stringify(input), 'news_highlight');
      const parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
      const src = new Set(numbersOf(JSON.stringify(input)).split(','));
      const ok = (t: string) => t.length >= 10 && t.length <= 240 && (t.match(/\d+/g) ?? []).every((n) => src.has(n));
      const pick = (x: any) => {
        const text = String(x?.text ?? '').trim();
        const m = rows[Number(x?.meeting) - 1];
        if (!m || !ok(text)) return null;
        return { text, path: `/meetings/${m.id}/postcall`, label: m.title ?? 'Встреча' };
      };
      const list = (Array.isArray(parsed?.insights) ? parsed.insights : []).map(pick).filter(Boolean).slice(0, 4) as { text: string; path: string; label: string }[];
      const best = parsed?.best ? pick(parsed.best) : null;
      return list.length || best ? { insights: list, best } : null;
    } catch (e) {
      this.log.warn(`выводы недели без модели ${tenantId}: ${(e as Error).message}`);
      return null;
    }
  }

  // ───────────────────────── кандидаты ─────────────────────────

  /** Вехи и релизы (§26–29): находим повод, человек решает — публиковать или нет. */
  async detectCandidates(tenantId: string): Promise<number> {
    let added = 0;
    /*
      #1526: «ИИ САМ формирует победный пост». При «Публиковать сами» (настройка
      «Новостей») веха и релиз выходят сразу, иначе — как раньше, в очередь одобрения.
      Ключ поста тот же, что у одобрения кандидата, — дублей не будет.
    */
    const auto = (await this.repo.settings(tenantId)).highlights_auto;
    const publish = async (c: { type: 'milestone' | 'release'; sourceKey: string; title: string; body: string; projectId: string; visibility: string; contributors: { user_id: string; name: string }[]; taskIds?: string[] }) => {
      const post = await this.feed.createSystem(tenantId, {
        type: c.type, title: c.title, body: c.body, status: 'published',
        visibility: c.visibility === 'all' ? 'all' : 'project', projectId: c.projectId,
        meta: { contributors: c.contributors.map((x) => ({ userId: x.user_id, name: x.name })), taskIds: c.taskIds ?? [] },
        dedupKey: c.sourceKey,
      });
      return !!post;
    };
    for (const m of await this.facts.milestoneCandidates(tenantId)) {
      const contributors = await this.facts.contributors(tenantId, { projectId: m.project_id });
      const day = new Date(m.last_closed).toISOString().slice(0, 10);
      const names = contributors.slice(0, 5).map((c) => c.name);
      const onTime = m.target_date ? (day <= m.target_date ? ` — точно к сроку ${m.target_date.split('-').reverse().join('.')}` : '') : '';
      if (auto) {
        if (await publish({
          type: 'milestone', sourceKey: `project:${m.project_id}:${day}`, projectId: m.project_id, visibility: m.visibility, contributors,
          title: `Ура! Веха завершена: «${m.name}»`,
          body: `Все задачи проекта «${m.name}» закрыты${onTime}: ${m.closed} ${plural(m.closed, 'задача', 'задачи', 'задач')}.`
            + (names.length ? `

Авторы: ${names.join(', ')}. Поздравляем ребят!` : ''),
        })) added++;
        continue;
      }
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
      if (auto) {
        if (await publish({
          type: 'release', sourceKey: `task:${t.id}`, projectId: t.project_id, visibility: t.visibility, contributors, taskIds: [t.id],
          title: `Релиз: ${t.title}`.slice(0, 200),
          body: `В проекте «${t.project_name}» вышел релиз «${t.title}».`
            + (contributors.length ? `

Авторы релиза: ${contributors.slice(0, 5).map((c) => c.name).join(', ')}. Поздравляем!` : ''),
        })) added++;
        continue;
      }
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
