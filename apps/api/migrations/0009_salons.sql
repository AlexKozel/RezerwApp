-- Салоны (D-021, D-022, D-053): подключение Independent-мастеров к Location, общий календарь busy_only,
-- публичная страница салона.

-- ---------------------------------------------------------------------------
-- Подключение только с согласия мастера
-- ---------------------------------------------------------------------------
-- Политика 0001 разрешала любой стороне вставку и изменение: салон мог сам «подключить» чужой Account
-- (и видеть его занятость, показывать его на своей странице) или вернуть в active уже ушедшего мастера.
-- Теперь: создаёт подключение только мастер (принимая приглашение салона), активирует только мастер,
-- завершить может любая сторона, удалить нельзя (история для расчёта аренды).
DROP POLICY membership_parties ON location_memberships;

CREATE POLICY membership_read ON location_memberships FOR SELECT
  USING (location_account_id = app_current_account() OR member_account_id = app_current_account());
CREATE POLICY membership_join ON location_memberships FOR INSERT
  WITH CHECK (member_account_id = app_current_account());
CREATE POLICY membership_update ON location_memberships FOR UPDATE
  USING (location_account_id = app_current_account() OR member_account_id = app_current_account())
  WITH CHECK (location_account_id = app_current_account() OR member_account_id = app_current_account());
REVOKE DELETE ON location_memberships FROM rezerwapp_app;

CREATE FUNCTION location_memberships_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id <> OLD.location_id OR NEW.location_account_id <> OLD.location_account_id
     OR NEW.member_account_id <> OLD.member_account_id THEN
    RAISE EXCEPTION 'membership parties cannot change' USING ERRCODE = 'check_violation', CONSTRAINT = 'membership_parties_fixed';
  END IF;
  IF NEW.status = 'active' AND OLD.status <> 'active' AND NEW.member_account_id IS DISTINCT FROM app_current_account() THEN
    RAISE EXCEPTION 'only the member can activate a membership' USING ERRCODE = 'check_violation', CONSTRAINT = 'membership_member_activates';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER location_memberships_guard_trg
  BEFORE UPDATE ON location_memberships
  FOR EACH ROW EXECUTE FUNCTION location_memberships_guard();

-- ---------------------------------------------------------------------------
-- Чтение между Account только через функции (D-046)
-- ---------------------------------------------------------------------------
GRANT SELECT ON locations, location_memberships TO rezerwapp_lookup;
CREATE POLICY lookup_read ON locations FOR SELECT TO rezerwapp_lookup USING (true);
CREATE POLICY lookup_read ON location_memberships FOR SELECT TO rezerwapp_lookup USING (true);

-- Общий календарь Location для салона: у подключённых мастеров только занятые интервалы (busy_only, D-021),
-- без клиентов, услуг и статусов. Вызывать может только Account, которому принадлежит Location.
CREATE FUNCTION location_busy(p_location uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (member_account_id uuid, staff_id uuid, staff_name text, starts_at timestamptz, ends_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_location AND l.account_id = public.app_current_account()) THEN
    RAISE EXCEPTION 'location not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_to <= p_from OR p_to - p_from > interval '62 days' THEN
    RAISE EXCEPTION 'range must be positive and at most 62 days' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT m.member_account_id, s.id, s.display_name, lower(b.slot), upper(b.slot)
      FROM public.location_memberships m
      JOIN public.accounts a ON a.id = m.member_account_id AND a.status = 'active'
      JOIN public.staff s ON s.account_id = m.member_account_id AND s.active
      JOIN public.bookings b ON b.staff_id = s.id AND b.slot && tstzrange(p_from, p_to)
                            AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > now()))
     WHERE m.location_id = p_location AND m.status = 'active'
     ORDER BY 4, 3;
END
$$;

-- Публичная страница салона: Location по slug и мастера (Employee этой Location и активные Independent).
CREATE FUNCTION public_location(p_slug text)
RETURNS TABLE (location_id uuid, name text, address text, staff_name text, staff_slug text, independent boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH loc AS (
    SELECT l.id, l.account_id, l.name, l.address
      FROM public.locations l JOIN public.accounts a ON a.id = l.account_id AND a.status = 'active'
     WHERE l.public_slug = p_slug
  ), people AS (
    SELECT s.display_name, s.public_slug, false AS independent
      FROM loc JOIN public.staff s ON s.account_id = loc.account_id AND s.location_id = loc.id AND s.active
    UNION ALL
    SELECT s.display_name, s.public_slug, true
      FROM loc
      JOIN public.location_memberships m ON m.location_id = loc.id AND m.status = 'active'
      JOIN public.accounts a ON a.id = m.member_account_id AND a.status = 'active'
      JOIN public.staff s ON s.account_id = m.member_account_id AND s.active
  )
  SELECT loc.id, loc.name, loc.address, p.display_name, p.public_slug, p.independent
    FROM loc LEFT JOIN people p ON true
   ORDER BY p.independent, p.display_name
$$;

-- Подключения текущего Account с обеих сторон, с названиями (салон не видит Account мастера под RLS и наоборот).
CREATE FUNCTION my_memberships()
RETURNS TABLE (id uuid, side text, location_id uuid, location_name text, location_slug text, salon_name text,
               member_account_id uuid, member_name text, status text, started_at timestamptz, ended_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.id,
         CASE WHEN m.location_account_id = public.app_current_account() THEN 'salon' ELSE 'member' END,
         l.id, l.name, l.public_slug, sa.name, m.member_account_id, ma.name, m.status, m.started_at, m.ended_at
    FROM public.location_memberships m
    JOIN public.locations l ON l.id = m.location_id
    JOIN public.accounts sa ON sa.id = m.location_account_id
    JOIN public.accounts ma ON ma.id = m.member_account_id
   WHERE public.app_current_account() IN (m.location_account_id, m.member_account_id)
   ORDER BY m.created_at
$$;

ALTER FUNCTION location_busy(uuid, timestamptz, timestamptz) OWNER TO rezerwapp_lookup;
ALTER FUNCTION public_location(text) OWNER TO rezerwapp_lookup;
ALTER FUNCTION my_memberships() OWNER TO rezerwapp_lookup;
REVOKE ALL ON FUNCTION location_busy(uuid, timestamptz, timestamptz), public_location(text), my_memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION location_busy(uuid, timestamptz, timestamptz), public_location(text), my_memberships() TO rezerwapp_app;
