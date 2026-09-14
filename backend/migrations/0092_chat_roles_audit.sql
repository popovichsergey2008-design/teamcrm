-- Сайдбар чата (ТЗ-5, этап 2): роли участников и журнал действий.
--
-- Роли. До сих пор «кто может менять группу» определялось создателем и должностью
-- в компании. Сайдбар показывает участников по ролям — владелец, администраторы,
-- участники, внешние — и даёт назначать администраторов: в большом канале
-- владелец один, а порядок наводить надо многим.
--   owner    — создатель; один на чат, не снимается;
--   admin    — назначен владельцем или другим администратором;
--   member   — все остальные;
--   external — человек со стороны (этап 5), видит только этот чат.
ALTER TABLE chat_members
    ADD COLUMN role VARCHAR(10) NOT NULL DEFAULT 'member';

-- Создатели уже существующих групп и каналов становятся владельцами — они
-- ими и были по смыслу, просто это нигде не было записано.
UPDATE chat_members m
   SET role = 'owner'
  FROM chats c
 WHERE c.id = m.chat_id
   AND c.created_by = m.user_id
   AND c.kind IN ('group', 'channel');

-- Описание чата было только у каналов (300 знаков) — теперь у любого чата, и длиннее:
-- регламент группы в три строки не помещается.
ALTER TABLE chats ALTER COLUMN description TYPE VARCHAR(2000);

-- Журнал: кто, когда и что сделал с чатом. Не сообщения — их и так видно, — а
-- действия, о которых потом спрашивают: «кто выкинул Юру из группы», «когда
-- переименовали». detail — свободный JSON: у переименования это старое и новое
-- название, у состава — кого, у задачи — её номер.
CREATE TABLE chat_audit (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    chat_id    BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    actor_id   BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    action     VARCHAR(32) NOT NULL,
    detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_audit_chat ON chat_audit (chat_id, id DESC);
