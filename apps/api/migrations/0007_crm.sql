-- Sprint 1: CRM (D-050). Автоочистка blacklist по сроку (D-024) выполняется фоновой задачей; список Account
-- с просроченными записями отдаёт функция SECURITY DEFINER (только id, как в 0006).

GRANT SELECT ON blacklist_entries TO rezerwapp_lookup;
CREATE POLICY lookup_read ON blacklist_entries FOR SELECT TO rezerwapp_lookup USING (true);

CREATE FUNCTION jobs_accounts_with_expired_blacklist()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT b.account_id FROM public.blacklist_entries b WHERE b.expires_at <= now()
$$;

ALTER FUNCTION jobs_accounts_with_expired_blacklist() OWNER TO rezerwapp_lookup;
REVOKE ALL ON FUNCTION jobs_accounts_with_expired_blacklist() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs_accounts_with_expired_blacklist() TO rezerwapp_app;

-- Поиск клиентов по имени и история визитов клиента.
CREATE INDEX clients_account_name_idx ON clients (account_id, lower(name));
CREATE INDEX bookings_client_idx ON bookings (client_id, starts_at DESC);
CREATE INDEX audit_log_account_at_idx ON audit_log (account_id, at DESC);
