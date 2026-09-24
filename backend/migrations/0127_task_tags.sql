-- Теги задач (ТЗ «Теги задач + автоматическая AI-разметка»).
--
-- Строим НЕ вторую систему рядом, а развиваем существующие метки: таблицы labels и
-- task_labels уже свои у каждой организации, уже показываются на карточках и доске, в
-- них уже импортируются теги из YouGile, Битрикса и Notion. Заводить рядом «теги» —
-- значит получить две сущности, которые в глазах человека одно и то же, и вечный
-- вопрос «а это метка или тег?». Названия таблиц оставляем (на них завязан код
-- импортов), в интерфейсе всё называется тегами — так их зовёт заказчик.

ALTER TABLE labels
    -- Имя для сравнения: «SEO», «seo» и «Seo» — один и тот же тег, и предупредить о
    -- дубле надо ДО того, как в компании появятся четыре варианта одного слова.
    ADD COLUMN IF NOT EXISTS normalized_name TEXT,
    -- Базовый набор организации: его нельзя удалять как случайно созданный.
    ADD COLUMN IF NOT EXISTS is_default      BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Когда применять тег — словами, для модели. Без этого ИИ выбирает по названию,
    -- а «Клиент-менеджер» по названию не значит ничего.
    ADD COLUMN IF NOT EXISTS ai_description  TEXT        NULL,
    -- Архив вместо удаления: тег остаётся у старых задач, но не предлагается в новых.
    ADD COLUMN IF NOT EXISTS archived_at     TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS created_by      BIGINT      NULL REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE labels SET normalized_name = lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))
 WHERE normalized_name IS NULL;

-- Индекс для поиска дублей, но НЕ уникальный: по ТЗ человек с правом может создать
-- похожий тег осознанно («Всё равно создать новый»), и запрет в базе это сломал бы.
CREATE INDEX IF NOT EXISTS labels_normalized_idx ON labels (tenant_id, normalized_name);
CREATE INDEX IF NOT EXISTS labels_active_idx ON labels (tenant_id) WHERE archived_at IS NULL;

ALTER TABLE task_labels
    -- Откуда взялся тег: поставил человек, предложил ИИ, проставила система.
    ADD COLUMN IF NOT EXISTS source        TEXT        NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(4,3) NULL,
    -- Кто подтвердил предложение ИИ: решение остаётся за человеком, и видно, за кем.
    ADD COLUMN IF NOT EXISTS confirmed_by  BIGINT      NULL REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS confirmed_at  TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS task_labels_label_idx ON task_labels (tenant_id, label_id);

-- Политика организации по тегам.
CREATE TABLE IF NOT EXISTS tag_settings (
    tenant_id            BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- ИИ подбирает теги — по умолчанию включено (требование ТЗ).
    ai_tagging           BOOLEAN NOT NULL DEFAULT TRUE,
    -- И его предложения обязательно подтверждает человек: молча закреплённый тег
    -- разъедает классификацию быстрее, чем её отсутствие.
    require_confirmation BOOLEAN NOT NULL DEFAULT TRUE,
    -- Кто вправе заводить новые теги: all | managers | admins. Крупные компании
    -- иначе получают «SEO», «seo», «СЕО» и «SEO задача» в одном списке.
    who_can_create       TEXT    NOT NULL DEFAULT 'all',
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Что предложил ИИ и что в итоге подтвердил человек. Нужно не ради отчётов, а ради
-- качества подсказок: по расхождению видно, где модель систематически ошибается.
-- Текст задачи не храним — только номера тегов.
CREATE TABLE IF NOT EXISTS ai_tag_feedback (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    task_id           BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    suggested_tag_ids BIGINT[] NOT NULL DEFAULT '{}',
    confirmed_tag_ids BIGINT[] NOT NULL DEFAULT '{}',
    corrected         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_tag_feedback_tenant_idx ON ai_tag_feedback (tenant_id, created_at DESC);

/*
  Базовый набор существующим организациям.

  Новые получают его при регистрации кодом (сид в миграции не покрыл бы тех, кто
  зарегистрируется завтра). Здесь — разовая досыпка тем, кто уже работает, и только
  если похожего тега у них ещё нет: компания могла завести «Программная задача» сама.
*/
INSERT INTO labels (tenant_id, name, color, is_default, normalized_name, ai_description)
SELECT t.id, d.name, d.color, TRUE, lower(d.name), d.hint
  FROM tenants t
  CROSS JOIN (VALUES
    ('Контентная задача',   '#2f7d5d', 'Тексты и наполнение: статьи, SEO-тексты, meta, карточки товаров, переводы, правка контента.'),
    ('Программная задача',  '#2f5fbf', 'Разработка: бэкенд, фронтенд, API, база данных, интеграции, исправление ошибок, доработка интерфейса.'),
    ('Дизайнерская задача', '#7c4dbf', 'Визуальное: макеты, баннеры, UI, прототипы, изображения, графика.'),
    ('Клиент-менеджер',     '#a35a10', 'Работа с клиентом: согласовать, уточнить требования, получить информацию или подтверждение, передать результат.'),
    ('Отложенная задача',   '#55606f', 'Сохранить, но пока не брать в работу: зависит от будущего события, вернуться позже, не потерять.')
  ) AS d(name, color, hint)
 WHERE NOT EXISTS (
   SELECT 1 FROM labels l
    WHERE l.tenant_id = t.id
      AND lower(btrim(regexp_replace(l.name, '\s+', ' ', 'g'))) = lower(d.name)
 );
