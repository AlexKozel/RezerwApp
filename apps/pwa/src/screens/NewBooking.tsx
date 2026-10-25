import { formatDayLabel, formatMoney, formatTime, pickText } from '@rezerwapp/shared';
import { useEffect, useState } from 'react';
import { api, type ClientSummary, type Me, type ServiceItem, type Staff } from '../api';
import { useT } from '../i18n';
import { addDays, atLocalTime, today } from '../lib/dates';
import { go } from '../router';

const DAYS = 14;

/**
 * Ручная запись (клиент позвонил или написал): клиент из базы или новый, услуга, день и время.
 * Время из свободных слотов или любое вручную: рабочие часы мастер может нарушить сам, пересечение запретит API.
 * Из недельной сетки приходят день, время и специалист (#/new/<день>/<ЧЧ:ММ>/<staffId>).
 */
export function NewBooking({ me, day: initialDay, time, staffId: initialStaff }: { me: Me; day?: string; time?: string; staffId?: string }) {
  const { t, locale } = useT();
  const tz = me.timeZone;
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffId, setStaffId] = useState(me.staffId ?? initialStaff ?? '');
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [variantId, setVariantId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<ClientSummary[]>([]);
  const [client, setClient] = useState<ClientSummary | null>(null);
  const [newClient, setNewClient] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [day, setDay] = useState(initialDay && /^\d{4}-\d{2}-\d{2}$/.test(initialDay) ? initialDay : today(tz));
  const [slots, setSlots] = useState<string[] | null>(null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [manualTime, setManualTime] = useState(time && /^\d{2}:\d{2}$/.test(time) ? time : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<ServiceItem[]>('GET', '/services').then((r) => setServices((r.data ?? []).filter((s) => s.active)));
    if (me.role !== 'staff') {
      void api<Staff[]>('GET', '/staff').then((r) => {
        const active = (r.data ?? []).filter((s) => s.active);
        setStaff(active);
        if (!staffId && active.length > 0) setStaffId(active[0]!.id);
      });
    }
  }, [me.role]);

  // Поиск клиента: телефон ищется точно, имя подстрокой (API, D-050).
  useEffect(() => {
    if (query.trim().length < 2) {
      setFound([]);
      return;
    }
    const id = setTimeout(() => {
      void api<ClientSummary[]>('GET', `/clients?search=${encodeURIComponent(query.trim())}`).then((r) => setFound((r.data ?? []).filter((c) => !c.anonymized)));
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    setStartsAt(null);
    if (!staffId || !variantId) return;
    setSlots(null);
    void api<{ slots: string[] }>('GET', `/staff/${staffId}/slots?variantId=${variantId}&from=${day}&to=${day}`).then((r) => {
      const list = r.data?.slots ?? [];
      setSlots(list);
      if (!r.ok) setError(t(r.error === 'NOT_FOUND' ? 'widget.no_slots' : 'pwa.error'));
      // Время из недельной сетки: если это свободный слот, выбираем его вместо ручного ввода.
      // manualTime читается из замыкания намеренно: важно только время, пришедшее в маршруте.
      const preset = manualTime ? atLocalTime(day, manualTime, tz) : null;
      if (preset && list.includes(preset)) {
        setStartsAt(preset);
        setManualTime('');
      }
    });
  }, [staffId, variantId, day]);

  const chosenTime = manualTime ? atLocalTime(day, manualTime, tz) : startsAt;
  const ready = staffId && variantId && chosenTime && (client || (newClient && name.trim() && phone.trim()));

  async function save() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const r = await api('POST', '/bookings', {
      staffId,
      serviceId,
      variantId,
      startsAt: chosenTime,
      ...(client ? { clientId: client.id } : { client: { name, phone, language: locale } }),
    });
    setBusy(false);
    if (r.ok) {
      window.alert(t('pwa.new.saved'));
      go('calendar');
    } else {
      setError(t(r.error === 'SLOT_TAKEN' ? 'booking.error.slot_taken' : r.error === 'NO_FREE_SLOTS' ? 'client.no_free_slots' : r.status === 403 ? 'pwa.forbidden' : 'pwa.error'));
    }
  }

  return (
    <main>
      <h1>{t('pwa.cal.new')}</h1>

      <h2>{t('pwa.new.client')}</h2>
      {client ? (
        <div className="option" aria-pressed="true">
          <span>{client.name}</span>
          <button type="button" className="secondary" onClick={() => setClient(null)}>
            ×
          </button>
        </div>
      ) : newClient ? (
        <>
          <label htmlFor="cname">{t('widget.name')}</label>
          <input id="cname" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="cphone">{t('widget.phone')}</label>
          <input id="cphone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </>
      ) : (
        <>
          <input type="search" aria-label={t('pwa.new.search')} placeholder={t('pwa.new.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          {found.map((c) => (
            <button key={c.id} type="button" className="option" onClick={() => setClient(c)}>
              {c.name}
            </button>
          ))}
          <button type="button" className="chip" style={{ marginTop: 8 }} onClick={() => setNewClient(true)}>
            + {t('pwa.new.new_client')}
          </button>
        </>
      )}

      {staff.length > 1 && (
        <>
          <h2>{t('pwa.new.staff')}</h2>
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
        </>
      )}

      <h2>{t('pwa.new.service')}</h2>
      {services.flatMap((s) =>
        s.variants
          .filter((v) => v.active)
          .map((v) => (
            <button
              key={v.id}
              type="button"
              className="option"
              aria-pressed={variantId === v.id}
              onClick={() => {
                setServiceId(s.id);
                setVariantId(v.id);
              }}
            >
              <span>
                {pickText(s.name, locale)}
                {pickText(v.name, locale) && <span className="muted"> · {pickText(v.name, locale)}</span>}
                <span className="muted"> · {t('widget.duration', { minutes: v.durationMin })}</span>
              </span>
              <span>{t('widget.price', { price: formatMoney(v.price, locale) })}</span>
            </button>
          )),
      )}

      <h2>{t('pwa.new.date')}</h2>
      <div className="days">
        {Array.from({ length: DAYS }, (_, i) => addDays(today(tz), i)).map((d) => (
          <button key={d} type="button" className="chip" aria-pressed={d === day} onClick={() => setDay(d)}>
            {formatDayLabel(d, locale)}
          </button>
        ))}
      </div>

      {variantId && (
        <>
          <h2>{t('pwa.new.time')}</h2>
          {slots === null ? (
            <p className="muted">…</p>
          ) : (
            <div className="slots">
              {slots.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="chip"
                  aria-pressed={!manualTime && startsAt === s}
                  onClick={() => {
                    setManualTime('');
                    setStartsAt(s);
                  }}
                >
                  {formatTime(new Date(s), tz, locale)}
                </button>
              ))}
            </div>
          )}
          <label htmlFor="manual">{t('pwa.new.time')} (HH:MM)</label>
          <input id="manual" type="time" value={manualTime} onChange={(e) => setManualTime(e.target.value)} />
        </>
      )}

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="primary" disabled={!ready || busy} onClick={() => void save()}>
        {t('pwa.new.save')}
      </button>
    </main>
  );
}
