-- Согласования: то, что ждёт решения человека и не является задачей.
--
-- «Утвердить бюджет», «подписать счёт», «согласовать отпуск», «клиент просит скидку 10%,
-- одобряем?» — сейчас всё это живёт в переписке и теряется. Задачей это оформлять неверно:
-- у задачи есть исполнитель и работа, а здесь нужен ровно один ответ — да или нет.
--
-- Осознанные ограничения, чтобы согласования не превратились в свалку:
--   • короткий текст, а не документ: суть должна читаться за пять секунд;
--   • ровно один адресат: «согласуйте кто-нибудь» не согласует никто;
--   • отказ обязан нести причину — «нет» без объяснения возвращается новым вопросом;
--   • необязательная привязка к задаче: чаще всего вопрос растёт из работы.
CREATE TABLE approvals (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    -- кто спрашивает и у кого
    author_id    BIGINT NOT NULL REFERENCES users(id),
    approver_id  BIGINT NOT NULL REFERENCES users(id),
    -- budget | invoice | vacation | question | other — влияет только на значок и подпись
    kind         VARCHAR(16) NOT NULL DEFAULT 'question',
    subject      VARCHAR(200) NOT NULL,          -- суть в одну строку
    details      VARCHAR(2000) NULL,             -- подробности, если нужны
    task_id      BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL,
    -- pending | approved | rejected | cancelled
    status       VARCHAR(12) NOT NULL DEFAULT 'pending',
    decision_note VARCHAR(500) NULL,             -- обязателен при отказе
    decided_at   TIMESTAMPTZ NULL,
    due_at       TIMESTAMPTZ NULL,               -- «нужно до»: попадает в сортировку дня
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Основная выборка — «что ждёт лично меня»: она открывается на каждом входе в «Фокус дня».
CREATE INDEX idx_approvals_inbox ON approvals (tenant_id, approver_id, status, created_at DESC);
-- Вторая по частоте — «что я отправил и чего жду».
CREATE INDEX idx_approvals_sent ON approvals (tenant_id, author_id, status, created_at DESC);
