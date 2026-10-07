-- ТЗ-16, волна 2. «Фокус дня» как дневной план человека, а не как поле у задачи.
--
-- Раньше фокус держался на tasks.focus_date: человек сам ставил «В сегодня», система
-- ничего не предлагала, а одно поле на задаче не умеет ни порядок, ни «почему», ни
-- «принял / поменял». Теперь у человека на каждый день — план (не больше одного) и в
-- нём до трёх главных действий. focus_date не удаляем: это сильный ручной сигнал
-- («я сам решил сделать это сегодня») — он превращается в закрепление.

CREATE TABLE focus_day_plans (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- день человека в ЕГО поясе: у сервера и у сотрудника в Новосибирске разные сутки
    focus_date        DATE NOT NULL,
    timezone          VARCHAR(64) NOT NULL,
    -- proposed → accepted / modified → in_progress → completed → closed
    status            VARCHAR(16) NOT NULL DEFAULT 'proposed',
    -- first_open — собран при первом открытии за день; recalc — по «Пересчитать»
    generation_source VARCHAR(16) NOT NULL DEFAULT 'first_open',
    score_version     VARCHAR(32) NOT NULL,
    accepted_at       TIMESTAMPTZ NULL,
    completed_at      TIMESTAMPTZ NULL,
    closed_at         TIMESTAMPTZ NULL,
    -- «Полезный план?» 👍 = 1, 👎 = -1 (волна 9)
    feedback          SMALLINT NULL,
    -- предложения «это важнее вашего #3», от которых человек отказался: второй раз не
    -- предлагаем (ключи вида task:15 / approval:4)
    dismissed         JSONB NOT NULL DEFAULT '[]',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- один план на человека в день: повторное открытие и гонка двух вкладок не плодят дублей
    UNIQUE (tenant_id, user_id, focus_date)
);

CREATE TABLE focus_day_items (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id           BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan_id             BIGINT NOT NULL REFERENCES focus_day_plans(id) ON DELETE CASCADE,
    -- task — своя задача · review — принять чужую работу · approval — дать согласование
    item_type           VARCHAR(16) NOT NULL,
    -- задача, к которой относится действие (у согласования без задачи — пусто)
    task_id             BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL,
    approval_id         BIGINT NULL REFERENCES approvals(id) ON DELETE SET NULL,
    -- 1 — главная миссия дня, 2 и 3 — важные
    rank                SMALLINT NOT NULL CHECK (rank BETWEEN 1 AND 3),
    -- название на момент выбора: показываем, только пока у человека есть доступ
    title_snapshot      VARCHAR(255) NOT NULL,
    priority_score      NUMERIC(5,1) NOT NULL DEFAULT 0,
    deadline_score      NUMERIC(5,1) NOT NULL DEFAULT 0,
    unlock_score        NUMERIC(5,1) NOT NULL DEFAULT 0,
    meeting_score       NUMERIC(5,1) NOT NULL DEFAULT 0,
    base_priority_score NUMERIC(5,1) NOT NULL DEFAULT 0,
    penalty             NUMERIC(5,1) NOT NULL DEFAULT 0,
    -- «почему эта задача»: готовые строки объяснения, собранные правилами
    reasons             JSONB NOT NULL DEFAULT '[]',
    -- ai — выбрал расчёт · user — добавил сам · pin — закрепил · legacy — был «В сегодня»
    source              VARCHAR(16) NOT NULL DEFAULT 'ai',
    pinned_by_user      BOOLEAN NOT NULL DEFAULT FALSE,
    -- active · done · removed (убрал сам) · replaced (заменил другой)
    status              VARCHAR(16) NOT NULL DEFAULT 'active',
    -- почему заменили (волна 9): not_relevant · wrong_priority · done · blocked · other
    change_reason       VARCHAR(24) NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Уникальность места (один активный элемент на ранг) держит код: перестановка
-- меняет места местами одним запросом, и уникальный индекс мешал бы ей посередине.
CREATE INDEX idx_focus_items_plan ON focus_day_items (plan_id, status, rank);

-- Новый «Фокус дня» включается организации отдельно: обкатываем у себя, потом всем.
ALTER TABLE tenants ADD COLUMN focus_v2 BOOLEAN NOT NULL DEFAULT FALSE;
