-- Этап 1 коммерческой архитектуры поддержки: роли техотдела и срочный доступ инженера.
--
-- До этой миграции «техотдел» был плоским: запись в platform_staff означала право
-- видеть очередь ВСЕХ клиентов и открыть любое обращение по номеру. Инженер, которого
-- позвали починить одну поломку, получал ровно то же, что и дежурный первой линии.
--
-- Коммерческая модель (03_SUPPORT_RBAC_AND_SECURITY) требует разного: первая линия
-- работает с очередью, инженер — только с тем обращением, куда его позвали, и только
-- пока эскалация идёт. Право читать чужую переписку не должно выдаваться навсегда
-- «на всякий случай».

/*
  Роли техотдела.

  Значения вместо прежних admin|agent:
    support           — дежурный первой линии: очередь, разговоры, ответы;
    support_admin     — плюс состав отдела, известные проблемы, сбои, справочник;
    engineer          — НЕ в очереди: только обращения с действующим доступом;
    incident_manager  — очередь и сбои, но не состав отдела;
    admin             — всё, включая настройки платформы.

  Колонку не переименовываем и не заводим вторую: `role` внутри platform_staff и так
  читается однозначно, а лишний столбец-синоним пришлось бы объяснять каждому, кто
  откроет таблицу через полгода.
*/
UPDATE platform_staff SET role = 'support' WHERE role = 'agent';
-- прежний 'admin' — это владелец платформы, он и остаётся admin

ALTER TABLE platform_staff
    ADD CONSTRAINT platform_staff_role_check
    CHECK (role IN ('support', 'support_admin', 'engineer', 'incident_manager', 'admin'));

/*
  Срочный доступ инженера к обращению.

  Отдельная таблица, а не флаг у участника разговора: у доступа есть срок, автор и
  возможность отзыва — три вещи, которых у строки «участник» нет и быть не должно.
  Участником разговора инженер остаётся и после отзыва (он там писал, это история);
  правом читать обращение распоряжается только эта таблица.

  `scope` — что именно открыто: сам разговор, диагностика, связанная задача, запись
  созвона. Сейчас все гранты выдаются полным набором, но поле есть сразу: сузить
  доступ потом дешевле, чем задним числом объяснять, почему инженер видел лишнее.
*/
CREATE TABLE support_engineer_grants (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    engineer_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_by      BIGINT NOT NULL REFERENCES users(id),
    scope           TEXT[] NOT NULL DEFAULT '{conversation,diagnostics,linked_bug,huddle}',
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ NULL,
    revoked_by      BIGINT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Проверка «есть ли живой доступ» идёт на каждом обращении инженера к разговору.
CREATE INDEX idx_engineer_grants_live
    ON support_engineer_grants (engineer_id, conversation_id)
    WHERE revoked_at IS NULL;

/*
  Журнал действий: кто и с какой ролью.

  Раньше в записи действия был только номер человека. Для разбора «почему в задаче
  клиента поменялся срок» этого мало: важно, в каком качестве человек действовал и
  откуда пришло подтверждение. Адрес и устройство пишем у ПОДТВЕРЖДЕНИЯ, а не у
  предложения: юридически значим момент согласия, а не момент, когда его попросили.
*/
ALTER TABLE support_actions
    ADD COLUMN actor_role   VARCHAR(24) NULL,
    ADD COLUMN approved_ip  VARCHAR(64) NULL,
    ADD COLUMN approved_ua  VARCHAR(256) NULL;

DO $$
DECLARE staff INT;
BEGIN
  SELECT count(*) INTO staff FROM platform_staff;
  RAISE NOTICE 'роли техотдела заданы, записей в отделе: %', staff;
END $$;
