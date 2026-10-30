import { formatMoney } from '@rezerwapp/shared';
import { useEffect, useState } from 'react';
import { api, type Me } from '../api';
import { useT } from '../i18n';
import { monthRange, today } from '../lib/dates';

interface Summary {
  bookings: Record<string, number>;
  noShowRate: { all: number | null; withFee: number | null; withoutFee: number | null };
  bookingFee: { completedWithFee: number; keptOnNoShow: number; keptOnLateCancel: number };
  revenue: number;
  discounts: number;
  visitCosts: number;
  services: Array<{ cost: number | null }>;
  expenses: { total: number } | null;
  profit: number | null;
}

const pct = (r: number | null) => (r === null ? '–' : String(Math.round(r * 100)));

/** «Сколько вы сэкономили» за текущий месяц (D-056): главное, неявки с оплатой и без неё. */
export function Stats({ me }: { me: Me }) {
  const { t, locale } = useT();
  const [s, setS] = useState<Summary | null>(null);

  useEffect(() => {
    const { from, to } = monthRange(today(me.timeZone), me.timeZone);
    void api<Summary>('GET', `/analytics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then((r) => setS(r.data ?? null));
  }, [me.timeZone]);

  if (!s) return <main><p className="muted">…</p></main>;
  const kept = s.bookingFee.keptOnNoShow + s.bookingFee.keptOnLateCancel;
  return (
    <main>
      <h1>{t('pwa.stats.title')}</h1>
      <div className="card">
        <p className="stat">{t('pwa.stats.completed', { count: s.bookings.completed ?? 0 })}</p>
        <p className="stat">{t('pwa.stats.revenue', { amount: formatMoney(s.revenue, locale) })}</p>
        {s.discounts > 0 && <p className="muted">{t('pwa.stats.discounts', { amount: formatMoney(s.discounts, locale) })}</p>}
      </div>
      <div className="card">
        <p className="stat">{t('pwa.stats.no_show', { rate: pct(s.noShowRate.all) })}</p>
        <p className="muted">{t('pwa.stats.no_show_split', { withFee: pct(s.noShowRate.withFee), withoutFee: pct(s.noShowRate.withoutFee) })}</p>
        <p className="stat">{t('pwa.stats.kept', { amount: formatMoney(kept, locale) })}</p>
      </div>
      {s.expenses && s.profit !== null && (
        <div className="card">
          <p className="muted">{t('pwa.stats.costs', { amount: formatMoney(s.services.reduce((sum, x) => sum + (x.cost ?? 0), 0), locale) })}</p>
          <p className="muted">{t('pwa.stats.expenses', { amount: formatMoney(s.expenses.total, locale) })}</p>
          <p className="stat">
            <strong>{t('pwa.stats.profit', { amount: formatMoney(s.profit, locale) })}</strong>
          </p>
          <a href="#/expenses">{t('pwa.stats.expenses_link')}</a>
          <p className="muted">{t('pwa.exp.disclaimer')}</p>
        </div>
      )}
    </main>
  );
}
