-- Sprint 1: поиск в обход контекста Account для двух случаев, когда Account ещё неизвестен:
-- вход мастера по email и публичная страница специалиста по slug (D-038, D-041).
--
-- Роль rezerwapp_lookup: NOLOGIN, без BYPASSRLS. Видит строки через отдельные политики только на чтение,
-- и только через функции ниже (SECURITY DEFINER, владелец rezerwapp_lookup). Приложение получает EXECUTE
-- на функции, но не на таблицы в обход RLS. Функции ищут строго по равенству: перебрать строки нельзя.

ALTER TABLE users ADD COLUMN password_hash text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rezerwapp_lookup') THEN
    CREATE ROLE rezerwapp_lookup NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- Мигратор должен иметь право передать владение функциями этой роли.
GRANT rezerwapp_lookup TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO rezerwapp_lookup;
GRANT SELECT ON accounts, users, staff TO rezerwapp_lookup;

CREATE POLICY lookup_read ON accounts FOR SELECT TO rezerwapp_lookup USING (true);
CREATE POLICY lookup_read ON users FOR SELECT TO rezerwapp_lookup USING (true);
CREATE POLICY lookup_read ON staff FOR SELECT TO rezerwapp_lookup USING (true);

-- Вход мастера: пользователь по точному email (без учёта регистра) в активном Account.
CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (user_id uuid, account_id uuid, role text, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.account_id, u.role, u.password_hash
    FROM public.users u
    JOIN public.accounts a ON a.id = u.account_id
   WHERE lower(u.email) = lower(p_email)
     AND u.password_hash IS NOT NULL
     AND a.status = 'active'
$$;

-- Публичная страница: активный специалист активного Account по точному slug.
CREATE FUNCTION public_find_staff(p_slug text)
RETURNS TABLE (account_id uuid, staff_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.account_id, s.id
    FROM public.staff s
    JOIN public.accounts a ON a.id = s.account_id
   WHERE s.public_slug = p_slug
     AND s.active
     AND a.status = 'active'
$$;

ALTER FUNCTION auth_find_user(text) OWNER TO rezerwapp_lookup;
ALTER FUNCTION public_find_staff(text) OWNER TO rezerwapp_lookup;
REVOKE ALL ON FUNCTION auth_find_user(text), public_find_staff(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(text), public_find_staff(text) TO rezerwapp_app;
