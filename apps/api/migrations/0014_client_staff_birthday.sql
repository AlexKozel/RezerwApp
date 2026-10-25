-- Клиенты, добавленные мастером вручную, и день рождения (D-065).

-- День рождения: только день и месяц (без года: для поздравлений и акций год не нужен, RODO: минимизация).
ALTER TABLE clients
  ADD COLUMN birth_month smallint,
  ADD COLUMN birth_day smallint,
  ADD CONSTRAINT clients_birthday_valid CHECK (
    (birth_month IS NULL) = (birth_day IS NULL)
    AND (birth_month IS NULL OR (
      birth_month BETWEEN 1 AND 12
      AND birth_day BETWEEN 1 AND CASE WHEN birth_month = 2 THEN 29 WHEN birth_month IN (4, 6, 9, 11) THEN 30 ELSE 31 END
    ))
  );
CREATE INDEX clients_birthday_idx ON clients (account_id, birth_month, birth_day) WHERE birth_month IS NOT NULL;

-- Отмечается ли день рождения в этот день. 29 февраля в невисокосный год отмечается 28 февраля.
CREATE FUNCTION birthday_on(month smallint, day smallint, on_date date)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT month IS NOT NULL AND (
    (month = extract(month FROM on_date) AND day = extract(day FROM on_date))
    OR (month = 2 AND day = 29 AND extract(month FROM on_date) = 2 AND extract(day FROM on_date) = 28
        AND extract(day FROM make_date(extract(year FROM on_date)::int, 3, 1) - 1) = 28)
  )
$$;

-- «Свои» клиенты специалиста (D-050): с записью к нему или добавленные им вручную. Вручную внесённый номер,
-- который уже есть в базе Account, привязывается к специалисту, а не дублируется.
CREATE TABLE client_staff (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  client_id   uuid NOT NULL,
  staff_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, staff_id),
  FOREIGN KEY (account_id, client_id) REFERENCES clients (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, staff_id) REFERENCES staff (account_id, id) ON DELETE CASCADE
);
CREATE INDEX client_staff_staff_idx ON client_staff (staff_id);

ALTER TABLE client_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_staff FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_staff
  USING (account_id = app_current_account()) WITH CHECK (account_id = app_current_account());
-- Права на таблицу rezerwapp_app получает через ALTER DEFAULT PRIVILEGES (0001).

-- Утреннее напоминание мастеру о днях рождения клиентов: Account, где в поясе Account уже 09:00 или позже,
-- сегодня есть именинники и напоминание за этот день ещё не отправлялось. Только id и местная дата (D-046).
-- Только нужные столбцы: имена и телефоны клиентов роли lookup недоступны.
GRANT SELECT (account_id, birth_month, birth_day, anonymized_at) ON clients TO rezerwapp_lookup;
GRANT SELECT (account_id, dedupe_key) ON notification_log TO rezerwapp_lookup;
CREATE POLICY lookup_read ON clients FOR SELECT TO rezerwapp_lookup USING (true);
CREATE POLICY lookup_read ON notification_log FOR SELECT TO rezerwapp_lookup USING (true);

CREATE FUNCTION jobs_accounts_with_birthdays()
RETURNS TABLE (account_id uuid, day text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.id, to_char(l.today, 'YYYY-MM-DD')
    FROM public.accounts a
   CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE a.timezone)::date AS today, (now() AT TIME ZONE a.timezone)::time AS at) l
   WHERE l.at >= time '09:00'
     AND EXISTS (SELECT 1 FROM public.clients c
                  WHERE c.account_id = a.id AND c.anonymized_at IS NULL AND public.birthday_on(c.birth_month, c.birth_day, l.today))
     AND NOT EXISTS (SELECT 1 FROM public.notification_log n
                      WHERE n.account_id = a.id AND n.dedupe_key = 'account.birthdays:' || to_char(l.today, 'YYYY-MM-DD'))
$$;

ALTER FUNCTION jobs_accounts_with_birthdays() OWNER TO rezerwapp_lookup;
REVOKE ALL ON FUNCTION jobs_accounts_with_birthdays() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs_accounts_with_birthdays() TO rezerwapp_app;
