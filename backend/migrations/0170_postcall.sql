-- ТЗ-22, этап 1: разбор встречи после звонка («Итоги встречи»).
--
-- Статус обработки встречи (queued → transcribing → analyzing → done | error) остаётся
-- как был: это про конвейер. Разбор — отдельная сущность про человека: увидел ли он
-- итоги, создал ли задачи, закрыл ли. Одна встреча — один разбор.

-- комната созвона: экран итогов открывается сразу после «Завершить», когда номера
-- встречи ещё нет, и находит её по комнате
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS room_id VARCHAR(64) NULL;
CREATE INDEX IF NOT EXISTS idx_meetings_room ON meetings (tenant_id, room_id) WHERE room_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meeting_postcall_reviews (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id        BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    meeting_id       BIGINT NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
    -- владелец разбора: организатор события, иначе тот, кто начал созвон;
    -- только он закрывает разбор и создаёт задачи пачкой
    owner_id         BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    -- processing | review_required | reviewed | completed
    status           VARCHAR(20) NOT NULL DEFAULT 'processing',
    -- false — у компании нет распознавания речи: короткий экран без итогов ИИ
    ai               BOOLEAN NOT NULL DEFAULT TRUE,
    -- готовность блоков по отдельности: pending | running | ready | failed | skipped
    transcript_status VARCHAR(12) NOT NULL DEFAULT 'pending',
    summary_status    VARCHAR(12) NOT NULL DEFAULT 'pending',
    decisions_status  VARCHAR(12) NOT NULL DEFAULT 'pending',
    tasks_status      VARCHAR(12) NOT NULL DEFAULT 'pending',
    followup_status   VARCHAR(12) NOT NULL DEFAULT 'pending',
    -- кто был на созвоне (вместе с молчавшими и гостями): [{userId, name, guest}]
    participants     JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- «Разобрать позже»: до этого времени разбор не напоминает о себе
    snoozed_until    TIMESTAMPTZ NULL,
    opened_at        TIMESTAMPTZ NULL,
    reviewed_at      TIMESTAMPTZ NULL,
    completed_at     TIMESTAMPTZ NULL,
    reminded_at      TIMESTAMPTZ NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_postcall_owner ON meeting_postcall_reviews (tenant_id, owner_id, status);

-- Задачи со встречи больше не создаются сами: после звонка человек видит черновики
-- и решает (решение заказчика 11.10.2026). Тумблер остаётся — кто хочет «само»,
-- включит его в настройках ассистента.
ALTER TABLE tenants ALTER COLUMN meeting_auto_tasks SET DEFAULT FALSE;
UPDATE tenants SET meeting_auto_tasks = FALSE WHERE meeting_auto_tasks;
