-- Уведомления (D-035, D-052): журнал отправок и выбор Account для напоминания клиенту за 24 часа.

-- Журнал без содержимого сообщений (DATA_MODEL.md, раздел 5: логи уведомлений 12 месяцев, без текста).
-- dedupe_key + recipient уникальны: одно событие доходит до получателя один раз даже при повторе задачи.
CREATE TABLE notification_log (
  id              bigserial PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  booking_id      uuid,
  dedupe_key      text NOT NULL,
  recipient_kind  text NOT NULL CHECK (recipient_kind IN ('client', 'user')),
  recipient_id    uuid NOT NULL,
  template        text NOT NULL,
  language        text NOT NULL CHECK (language IN ('pl', 'uk', 'ru', 'en')),
  channel         text CHECK (channel IN ('push', 'messenger', 'email', 'sms')),
  -- queued: взято в работу; sent: отправлено провайдером; sandbox: провайдер не подключён, отправка
  -- только залогирована; skipped: получателю нечем доставить (нет контакта или исчерпан лимит SMS);
  -- failed: все каналы вернули ошибку.
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'sandbox', 'skipped', 'failed')),
  reason          text,
  cost            numeric(10, 4) CHECK (cost IS NULL OR cost >= 0),
  attempts        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (account_id, dedupe_key, recipient_kind, recipient_id),
  FOREIGN KEY (account_id, booking_id) REFERENCES bookings (account_id, id) ON DELETE CASCADE
);
CREATE INDEX notification_log_account_created_idx ON notification_log (account_id, created_at DESC);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_log
  USING (account_id = app_current_account()) WITH CHECK (account_id = app_current_account());
-- Права по умолчанию (0001) уже выданы; журнал не удаляется приложением.
REVOKE DELETE ON notification_log FROM rezerwapp_app;

-- Напоминание клиенту за 24 часа: Account с подтверждёнными визитами в ближайшие сутки (только id, D-046).
CREATE FUNCTION jobs_accounts_with_upcoming()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT b.account_id FROM public.bookings b
   WHERE b.status = 'confirmed' AND b.starts_at > now() AND b.starts_at <= now() + interval '24 hours'
$$;

ALTER FUNCTION jobs_accounts_with_upcoming() OWNER TO rezerwapp_lookup;
REVOKE ALL ON FUNCTION jobs_accounts_with_upcoming() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs_accounts_with_upcoming() TO rezerwapp_app;

CREATE INDEX bookings_confirmed_starts_idx ON bookings (starts_at) WHERE status = 'confirmed';
