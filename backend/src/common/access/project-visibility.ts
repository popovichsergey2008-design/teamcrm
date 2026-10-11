/**
 * Видит ли человек проект — ОДНО правило на все запросы, где данные проекта уходят
 * за пределы самого проекта: поиск, база знаний, ИИ, встречи, файлы (ТЗ-21, этап 0).
 *
 * Правило то же, что в списке проектов (`projects.repository.canSee`):
 * - владелец и руководитель видят всё;
 * - сотрудник — открытые проекты (`visibility='all'`), свои и те, где он участник;
 * - клиент — проекты своей компании (как в портале) и где он участник: «открытый» — для команды.
 *
 * Раньше эти пути фильтровали только по компании, и закрытый проект утекал через поиск,
 * ответы ИИ (с общим кэшем на всю компанию), список встреч и скачивание записи по номеру.
 */
export interface ProjectViewer {
  userId: string;
  role: string;
}

/** Видит всё — без проверки по проектам. */
export const seesAllProjects = (v: ProjectViewer) => v.role === 'owner' || v.role === 'manager';

/**
 * SQL-условие «проект `projectExpr` виден». Параметры — номера плейсхолдеров:
 * `user` (bigint), `all` (boolean), `client` (boolean). `projectExpr` может быть NULL —
 * тогда условие ложно: «без проекта» решает вызывающий (обычно — видно всем).
 */
export function projectVisibleSql(projectExpr: string, p: { user: string; all: string; client: string }): string {
  return `(${p.all}::boolean OR EXISTS (
    SELECT 1 FROM projects vp
     WHERE vp.id = (${projectExpr})::bigint
       AND ((NOT ${p.client}::boolean AND vp.visibility = 'all')
            -- клиент видит проекты своей компании — как в клиентском портале
            OR (${p.client}::boolean AND vp.client_id IS NOT NULL
                AND vp.client_id = (SELECT cu.client_id FROM users cu WHERE cu.id = ${p.user}::bigint))
            OR vp.owner_user_id = ${p.user}::bigint
            OR EXISTS (SELECT 1 FROM project_members vpm WHERE vpm.project_id = vp.id AND vpm.user_id = ${p.user}::bigint))))`;
}

/** Значения параметров для `projectVisibleSql` в порядке user, all, client. */
export function viewerParams(v: ProjectViewer): [string, boolean, boolean] {
  return [String(v.userId), seesAllProjects(v), v.role === 'client'];
}

/**
 * Видна ли встреча `m` (алиас таблицы meetings): встреча проекта — по видимости проекта;
 * созвон из личного или группового чата — участникам этого чата и автору записи; без
 * проекта и чата (загруженная запись) — как раньше, всей команде.
 */
export function meetingVisibleSql(m: string, p: { user: string; all: string; client: string }): string {
  return `((${m}.project_id IS NULL OR ${projectVisibleSql(`${m}.project_id`, p)})
    AND (${m}.chat_id IS NULL OR ${m}.created_by = ${p.user}::bigint
         OR EXISTS (SELECT 1 FROM chats mc WHERE mc.id = ${m}.chat_id
                     AND (mc.kind = 'project'
                          OR EXISTS (SELECT 1 FROM chat_members mcm WHERE mcm.chat_id = mc.id AND mcm.user_id = ${p.user}::bigint)))))`;
}
