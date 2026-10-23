-- #1562 «Тестовый сотрудник для проверки интерфейса».
--
-- Кто в какой организации может войти как какой тестовый сотрудник. Строки сюда
-- добавляют вручную SQL-запросом на сервере; без строки кнопки нет ни у кого.
-- Миграция ничего не вставляет: на чистых базах (e2e, staging) нужных людей нет.
CREATE TABLE IF NOT EXISTS qa_switch_access (
    tenant_id      BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id        BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- кто переключается
    target_user_id BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- тестовый сотрудник
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, target_user_id),
    CHECK (user_id <> target_user_id)
);
CREATE INDEX IF NOT EXISTS idx_qa_switch_target ON qa_switch_access (tenant_id, target_user_id);
