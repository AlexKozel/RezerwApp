import { LOCALES, type Locale } from '@rezerwapp/shared';
import { useEffect, useState } from 'react';
import { api, type Me, type Staff } from '../api';
import { LANGUAGE_NAMES, useT } from '../i18n';
import { invalidRows, toIntervals, toRows, type ApiInterval, type DayRow } from '../lib/hours';

interface Reliability {
  threshold: number;
  redeemVisits: number;
  depositPercent: number | null;
}

/**
 * «Ненадёжные клиенты» (D-066, owner): порог случаев, визиты до снятия отметки, предоплата для ненадёжных в % цены
 * (до 50%, выше 30% предупреждение, как у оплаты услуг, D-014). Без номера BLIK включить предоплату нельзя.
 */
function ReliabilitySection() {
  const { t } = useT();
  const [value, setValue] = useState<Reliability | null>(null);
  const [percent, setPercent] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void api<Reliability>('GET', '/account/reliability').then((r) => {
      if (!r.data) return;
      setValue(r.data);
      setPercent(r.data.depositPercent === null ? '' : String(r.data.depositPercent));
    });
  }, []);

  if (!value) return null;
  const n = Number(percent);
  const percentValid = Number.isInteger(n) && n >= 1 && n <= 50;
  const enabled = value.depositPercent !== null || percent !== '';

  async function save(patch: Partial<Reliability>) {
    const r = await api<Reliability>('PATCH', '/account/reliability', patch);
    if (r.data) {
      setValue(r.data);
      setPercent(r.data.depositPercent === null ? '' : String(r.data.depositPercent));
    }
    setMessage({ ok: r.ok, text: t(r.ok ? 'pwa.set.saved' : r.error === 'VALIDATION' && patch.depositPercent ? 'pwa.set.blik_required' : 'pwa.error') });
  }

  const counter = (label: string, current: number, key: 'threshold' | 'redeemVisits') => (
    <>
      <label htmlFor={`rel-${key}`}>{label}</label>
      <select id={`rel-${key}`} value={current} onChange={(e) => void save({ [key]: Number(e.target.value) })}>
        {[1, 2, 3, 4, 5].map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </>
  );

  return (
    <section>
      <h2>{t('pwa.set.reliability')}</h2>
      <p className="muted">{t('pwa.set.reliability_hint')}</p>
      {counter(t('pwa.set.unreliable_threshold'), value.threshold, 'threshold')}
      {counter(t('pwa.set.unreliable_redeem'), value.redeemVisits, 'redeemVisits')}
      <label className="check" style={{ marginTop: 16 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => (e.target.checked ? setPercent('20') : void save({ depositPercent: null }))}
        />
        <span>{t('pwa.set.unreliable_deposit')}</span>
      </label>
      <p className="muted">{t('pwa.set.unreliable_deposit_hint')}</p>
      {enabled && (
        <div className="row">
          <div>
            <label htmlFor="rel-percent">{t('pwa.set.percent')}</label>
            <input id="rel-percent" type="text" inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value.replace(/\D/g, ''))} />
          </div>
          <button type="button" className="secondary" disabled={!percentValid} onClick={() => void save({ depositPercent: n })}>
            {t('pwa.set.save')}
          </button>
        </div>
      )}
      {enabled && percentValid && n > 30 && <p className="notice warn">{t('pwa.cat.fee_warning')}</p>}
      {message && <p className={`notice ${message.ok ? 'ok' : 'error'}`}>{message.text}</p>}
    </section>
  );
}

/** Финансы (D-071, owner): поле «доп. затраты» у визитов. Новое значение видно после перезагрузки приложения. */
function FinanceSection() {
  const { t } = useT();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void api<{ trackVisitCosts: boolean }>('GET', '/account/finance').then((r) => setOn(r.data?.trackVisitCosts ?? null));
  }, []);
  if (on === null) return null;
  const toggle = async (value: boolean) => {
    const r = await api<{ trackVisitCosts: boolean }>('PATCH', '/account/finance', { trackVisitCosts: value });
    if (r.data) setOn(r.data.trackVisitCosts);
  };
  return (
    <section>
      <h2>{t('pwa.set.finance')}</h2>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} />
        <span>{t('pwa.set.track_visit_costs')}</span>
      </label>
      <a href="#/expenses">{t('pwa.stats.expenses_link')}</a>
    </section>
  );
}

/** Скидки (D-070, owner): разрешить наёмным мастерам ставить постоянную скидку своим клиентам. */
function DiscountSection() {
  const { t } = useT();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void api<{ staffCanDiscount: boolean }>('GET', '/account/discounts').then((r) => setOn(r.data?.staffCanDiscount ?? null));
  }, []);
  if (on === null) return null;
  const toggle = async (value: boolean) => {
    const r = await api<{ staffCanDiscount: boolean }>('PATCH', '/account/discounts', { staffCanDiscount: value });
    if (r.data) setOn(r.data.staffCanDiscount);
  };
  return (
    <section>
      <h2>{t('pwa.set.discounts')}</h2>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} />
        <span>{t('pwa.set.staff_can_discount')}</span>
      </label>
    </section>
  );
}

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

      <a className="option" href="#/services">
        <span>{t('pwa.cat.title')}</span>
        <span aria-hidden="true">›</span>
      </a>
      {me.role === 'owner' && (
        <a className="option" href="#/team">
          <span>{t('pwa.team.title')}</span>
          <span aria-hidden="true">›</span>
        </a>
      )}
      <a className="option" href="#/password">
        <span>{t('pwa.pwd.title')}</span>
        <span aria-hidden="true">›</span>
      </a>

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

      {me.role === 'owner' && <ReliabilitySection />}
      {me.role === 'owner' && <DiscountSection />}
      {me.role === 'owner' && <FinanceSection />}

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
