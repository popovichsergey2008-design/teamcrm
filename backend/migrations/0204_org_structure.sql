-- #4615, доработка 23.10: структура компании и одно правило подбора исполнителя.
--
-- Жалоба заказчика: «он всегда подставляет Глеба» — руководители отделов не заданы,
-- и подбор брал наименее загруженного. Теперь у компании своя структура: должности
-- с уровнем иерархии, отделы с руководителем, заместителями и вышестоящим отделом,
-- у сотрудника — «кому подчиняется». Всё — настройка каждой компании, в коде ничего
-- под конкретного клиента.

-- 1. Должности: уровень иерархии (набор фиксированный, названия — свои) и порядок.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS level VARCHAR(16) NOT NULL DEFAULT 'specialist';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE positions ADD CONSTRAINT positions_level_chk
    CHECK (level IN ('ceo', 'head', 'deputy', 'specialist', 'intern'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- уровень уже заведённых должностей — разово, по названию (дальше правит компания);
-- position_id у людей не трогаем
UPDATE positions SET level = CASE
    WHEN lower(name) ~ '(генеральн|гендиректор|ceo|основател|владел|собственник|президент)' THEN 'ceo'
    WHEN lower(name) ~ '(руководител|начальник|директор|head)' THEN 'head'
    WHEN lower(name) ~ '(тимлид|team ?lead|заместител|ведущ|старш|lead)' THEN 'deputy'
    WHEN lower(name) ~ '(стажер|стажёр|intern|практикант|ученик)' THEN 'intern'
    ELSE 'specialist' END;
UPDATE positions p SET sort_order = o.n
  FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY
          CASE level WHEN 'ceo' THEN 1 WHEN 'head' THEN 2 WHEN 'deputy' THEN 3 WHEN 'specialist' THEN 4 ELSE 5 END, name) AS n
          FROM positions) o
 WHERE o.id = p.id;

-- готовые должности — только компаниям, у которых должностей ещё нет совсем
INSERT INTO positions (tenant_id, name, level, sort_order)
SELECT t.id, d.name, d.level, d.ord
  FROM tenants t
 CROSS JOIN (VALUES ('Генеральный директор', 'ceo', 1), ('Руководитель отдела', 'head', 2),
                    ('Тимлид', 'deputy', 3), ('Специалист', 'specialist', 4), ('Стажёр', 'intern', 5)) AS d(name, level, ord)
 WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.tenant_id = t.id)
ON CONFLICT (tenant_id, name) DO NOTHING;

-- 2. Отделы: вышестоящий отдел (вложенность) и заместители/тимлиды.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS parent_id BIGINT NULL REFERENCES groups(id) ON DELETE SET NULL;
ALTER TABLE user_groups ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'member';
DO $$ BEGIN
  ALTER TABLE user_groups ADD CONSTRAINT user_groups_role_chk CHECK (role IN ('member', 'deputy'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Сотрудник: кому подчиняется (не задан — руководитель его отдела).
ALTER TABLE users ADD COLUMN IF NOT EXISTS reports_to_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL;

-- 4. Теги без подтверждения по умолчанию: подбираются и ставятся сами. Раньше
--    подтверждение было принудительным (выключить было нельзя), поэтому включённое
--    у компаний — не их выбор; включить заново можно в настройках тегов.
ALTER TABLE tag_settings ALTER COLUMN require_confirmation SET DEFAULT FALSE;
UPDATE tag_settings SET require_confirmation = FALSE, updated_at = now() WHERE require_confirmation;

-- 5. Обучение на правках: постановщик переназначил задачу направления на человека.
--    Два раза одного и того же — предложить сделать его руководителем направления.
CREATE TABLE IF NOT EXISTS org_reassign_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    manager_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill       VARCHAR(16) NOT NULL,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id     BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (task_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_reassign ON org_reassign_log (tenant_id, manager_id, skill, user_id);
