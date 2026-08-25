-- Zero-Maintenance: уборка того, что все давно бросили.
--
-- В любой живой доске накапливается мусор: задачи, о которых забыли полгода назад,
-- проекты, где всё закрыто и никто не заходит, черновики со встреч, которые никто
-- не подтвердил. Никто не убирает это не из лени, а потому что страшно: вдруг нужное.
--
-- Поэтому здесь ДВЕ страховки, и обе обязательны.
--   1. Система ничего не делает сама. Она только предлагает — решает человек.
--      Это единственное место ассистента, где даже автопилот не даёт права действовать:
--      напоминание можно проигнорировать, а закрытую задачу человек может не заметить.
--   2. Всё сделанное обратимо. В `undo` лежит ровно то состояние, куда возвращать,
--      и кнопка «Вернуть» стоит рядом с записью о выполненном.
CREATE TABLE maintenance_proposals (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    -- task_stale | project_idle | draft_stale
    kind         VARCHAR(24) NOT NULL,
    subject_type VARCHAR(16) NOT NULL,   -- task | project | draft
    -- Без внешнего ключа намеренно: объект могут удалить руками, а запись о том,
    -- что мы про него спрашивали, должна пережить удаление.
    subject_id   BIGINT NOT NULL,
    title        VARCHAR(255) NOT NULL,  -- как называется то, что предлагаем убрать
    text         VARCHAR(300) NOT NULL,  -- строка для человека: что и почему
    -- pending | applied | dismissed | reverted
    status       VARCHAR(12) NOT NULL DEFAULT 'pending',
    -- Куда возвращать при откате: колонка и позиция задачи, статус проекта и т.п.
    undo         JSONB NOT NULL DEFAULT '{}'::jsonb,
    /**
     * Один объект — один вопрос. Человек сказал «не надо» — больше не спрашиваем:
     * уборщик, который каждую неделю предлагает выбросить одно и то же, становится
     * фоном, а вместе с ним и все остальные предложения ассистента.
     */
    dedup_key    VARCHAR(120) NOT NULL,
    decided_by   BIGINT NULL REFERENCES users(id),
    decided_at   TIMESTAMPTZ NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_maintenance_dedup ON maintenance_proposals (tenant_id, dedup_key);
CREATE INDEX idx_maintenance_list ON maintenance_proposals (tenant_id, status, created_at DESC);

-- Предлагать ли уборку вообще. Включено: предложение ничего не делает без человека,
-- а выключить проще, чем догадаться, что такое есть.
ALTER TABLE tenants
    ADD COLUMN maintenance_enabled BOOLEAN NOT NULL DEFAULT TRUE;
