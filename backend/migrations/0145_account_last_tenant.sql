-- Пространство, в котором человек работал последним.
--
-- Вход по паролю (и через Google) раньше всегда вёл в САМОЕ СТАРОЕ членство. Человек
-- регистрируется, получает своё пустое пространство, потом его приглашают в рабочее —
-- и каждый вход снова открывает пустое, а не рабочее. Выбор нигде не запоминался.
--
-- Теперь запоминаем: при каждом входе, переключении и обновлении сессии.
ALTER TABLE accounts
    ADD COLUMN last_tenant_id BIGINT NULL REFERENCES tenants(id) ON DELETE SET NULL;

-- Тем, кто уже работает, — пространство их самой свежей сессии: иначе исправление
-- заработало бы только после первого переключения, а жалоба — уже сейчас.
UPDATE accounts a
   SET last_tenant_id = s.tenant_id
  FROM (
    SELECT DISTINCT ON (u.account_id) u.account_id, u.tenant_id
      FROM refresh_tokens rt
      JOIN users u ON u.id = rt.user_id
     WHERE u.account_id IS NOT NULL AND u.is_active = TRUE
     ORDER BY u.account_id, COALESCE(rt.last_used_at, rt.created_at) DESC
  ) s
 WHERE s.account_id = a.id;
