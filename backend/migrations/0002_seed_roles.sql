-- Базовый набор ролей RBAC (master → Multi-tenancy и RBAC).
INSERT INTO roles (code, description) VALUES
    ('owner',   'Владелец организации — полный доступ'),
    ('manager', 'Менеджер — управление проектами и задачами'),
    ('member',  'Сотрудник — работа с задачами'),
    ('client',  'Клиент — только client-представление, без финансов')
ON CONFLICT (code) DO NOTHING;
