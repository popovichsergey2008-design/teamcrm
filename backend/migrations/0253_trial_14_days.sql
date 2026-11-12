-- #4778: пробный период — 14 дней сразу, без «+7 за Telegram-бота».
-- Кто зарегистрировался по схеме 7 + 7 и бонус не получил (теперь его не получить),
-- доводим до 14 дней от начала пробного. Оплаченных, «вечных» и продлённых вендором не трогаем.
UPDATE tenants t
   SET trial_ends_at = t.trial_started_at + interval '14 days', updated_at = now()
 WHERE t.trial_started_at IS NOT NULL
   AND NOT t.is_platform
   AND t.trial_bonus_days = 0
   AND t.trial_ends_at > now()
   AND t.trial_ends_at < t.trial_started_at + interval '14 days'
   AND NOT EXISTS (SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id = t.id
                    AND (s.current_period_end IS NOT NULL OR s.complimentary OR s.trial_ends_at IS NOT NULL));
