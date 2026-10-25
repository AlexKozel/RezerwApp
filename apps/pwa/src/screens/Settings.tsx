import { LOCALES, type Locale } from '@rezerwapp/shared';
import { useEffect, useState } from 'react';
import { api, type Me, type Staff } from '../api';
import { useT } from '../i18n';
import { invalidRows, toIntervals, toRows, type ApiInterval, type DayRow } from '../lib/hours';

const LANGUAGE_NAMES: Record<Locale, string> = { pl: 'Polski', uk: 'Українська', ru: 'Русский', en: 'English' };
/** Адрес виджета клиента для ссылки «link in bio». */
const PUBLIC_URL = (import.meta.env.VITE_PUBLIC_URL as string | undefined) ?? 'http://localhost:3002';

/** Настройки: ссылка записи, реквизиты BLIK (owner, D-048), график и выходные (D-043), язык, выход. */
export function Settings({ me, onLogout, onLocale }: { me: Me; onLogout: () => void; onLocale: (l: Locale) => void }) {
  const { t, locale } = useT();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffId, setStaffId] = useState(me.staffId ?? '');
  const [rows, setRows] = useState<DayRow[] | null>(null);
  const [dayOff, setDayOff] = useState('');
  const [blik, setBlik] = useState('');
  const [recipient, setRecipient] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void api<Staff[]>('GET', '/staff').then((r) => {
      const list = (r.data ?? []).filter((s) => s.active && (me.role !== 'staff' || s.id === me.staffId));
      setStaff(list);
      if (!staffId && list[0]) setStaffId(list[0].id);
    });
    if (me.role === 'owner') {
      void api<{ blikPhone: string | null; recipient: string | null }>('GET', '/account/payment').then((r) => {
        setBlik(r.data?.blikPhone ?? '');
        setRecipient(r.data?.recipient ?? '');
      });
    }
    // Список специалистов и реквизиты загружаются один раз.
  }, [me.role]);

  useEffect(() => {
    if (!staffId) return;
    setRows(null);
    void api<ApiInterval[]>('GET', `/staff/${staffId}/working-hours`).then((r) => setRows(toRows(r.data ?? [])));
  }, [staffId]);

  const done = (ok: boolean) => setMessage({ ok, text: t(ok ? 'pwa.set.saved' : 'pwa.error') });

  async function savePayment() {
    done((await api('PATCH', '/account/payment', { blikPhone: blik.trim() || null, recipient: recipient.trim() || null })).ok);
  }

  async function saveHours() {
    if (!rows || invalidRows(rows).length > 0) return done(false);
    done((await api('PUT', `/staff/${staffId}/working-hours`, { intervals: toIntervals(rows) })).ok);
  }

  async function addDayOff() {
    if (!dayOff) return;
    const r = await api('POST', `/staff/${staffId}/days-off`, { date: dayOff });
    done(r.ok);
    if (r.ok) setDayOff('');
  }

  const weekday = (w: number) =>
    new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + w)));
  const update = (w: number, patch: Partial<DayRow>) => setRows((rs) => rs!.map((r) => (r.weekday === w ? { ...r, ...patch } : r)));
  const current = staff.find((s) => s.id === staffId);

  return (
    <main>
      <h1>{t('pwa.nav.settings')}</h1>
      {message && (
        <p className={`notice ${message.ok ? 'ok' : 'error'}`} role="status">
          {message.text}
        </p>
      )}

      {staff.length > 1 && (
        <select aria-label={t('pwa.new.staff')} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName}
            </option>
          ))}
        </select>
      )}

      {current && (
        <section>
          <h2>{t('pwa.set.link')}</h2>
          <div className="link-row">
            <a href={`${PUBLIC_URL}/${current.publicSlug}`} target="_blank" rel="noopener">
              {`${PUBLIC_URL}/${current.publicSlug}`}
            </a>
          </div>
        </section>
      )}

      {rows && (
        <section>
          <h2>{t('pwa.set.hours')}</h2>
          <div className="hours">
            {rows.map((r) => (
              <div key={r.weekday} style={{ display: 'contents' }}>
                <label className="check" style={{ margin: 0 }}>
                  <input type="checkbox" checked={r.open} onChange={(e) => update(r.weekday, { open: e.target.checked })} />
                  <span style={{ textTransform: 'capitalize' }}>{weekday(r.weekday)}</span>
                </label>
                {r.open ? (
                  <>
                    <input type="time" aria-label={`${weekday(r.weekday)} start`} value={r.start} onChange={(e) => update(r.weekday, { start: e.target.value })} />
                    <input type="time" aria-label={`${weekday(r.weekday)} end`} value={r.end} onChange={(e) => update(r.weekday, { end: e.target.value })} />
                  </>
                ) : (
                  <>
                    <span className="muted">{t('pwa.set.closed')}</span>
                    <span />
                  </>
                )}
              </div>
            ))}
          </div>
          <button type="button" className="secondary" style={{ marginTop: 12 }} onClick={() => void saveHours()}>
            {t('pwa.set.save')}
          </button>

          <h2>{t('pwa.set.day_off')}</h2>
          <div className="row">
            <input type="date" aria-label={t('pwa.set.day_off')} value={dayOff} onChange={(e) => setDayOff(e.target.value)} />
            <button type="button" className="secondary" disabled={!dayOff} onClick={() => void addDayOff()}>
              {t('pwa.set.add_day_off')}
            </button>
          </div>
        </section>
      )}

      {me.role === 'owner' && (
        <section>
          <h2>{t('booking.fee.label')}</h2>
          <label htmlFor="blik">{t('pwa.set.blik')}</label>
          <input id="blik" type="tel" inputMode="tel" value={blik} onChange={(e) => setBlik(e.target.value)} />
          <label htmlFor="recipient">{t('pwa.set.recipient')}</label>
          <input id="recipient" type="text" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
          <button type="button" className="secondary" style={{ marginTop: 12 }} onClick={() => void savePayment()}>
            {t('pwa.set.save')}
          </button>
        </section>
      )}

      <h2>{t('widget.language')}</h2>
      <div className="days">
        {LOCALES.map((l) => (
          <button key={l} type="button" className="chip" aria-pressed={l === locale} onClick={() => onLocale(l)}>
            {LANGUAGE_NAMES[l]}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="secondary"
        style={{ marginTop: 24 }}
        onClick={() => void api('POST', '/auth/logout').then(onLogout)}
      >
        {t('pwa.logout')}
      </button>
    </main>
  );
}
