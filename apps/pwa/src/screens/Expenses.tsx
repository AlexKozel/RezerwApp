import { formatMoney, type MessageKey } from '@rezerwapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from '../api';
import { useT } from '../i18n';
import { addMonths } from '../lib/calendar';
import { today } from '../lib/dates';
import { parseAmount } from '../lib/money';

const CATEGORIES = ['rent', 'materials', 'training', 'marketing', 'taxes', 'equipment', 'software', 'other'] as const;
type Category = (typeof CATEGORIES)[number];

interface Expense {
  id: string;
  spentOn: string;
  category: Category;
  amount: number;
  note: string | null;
}
interface Charge {
  recurringId: string;
  chargedOn: string;
  category: Category;
  amount: number;
  note: string | null;
}
interface Rule {
  id: string;
  category: Category;
  amount: number;
  note: string | null;
  dayOfMonth: number;
  startsOn: string;
  endsOn: string | null;
}
interface ExpenseList {
  items: Expense[];
  charges: Charge[];
  recurring: Rule[];
  totals: { total: number; byCategory: Partial<Record<Category, number>> };
}

/**
 * Журнал расходов «для себя» (D-071, owner): месяц, итог по категориям, разовые расходы и начисления
 * ежемесячных (аренда, подписки), добавление и остановка. Не бухгалтерия: подпись под экраном.
 */
export function Expenses({ me }: { me: Me }) {
  const { t, locale } = useT();
  const [month, setMonth] = useState(() => `${today(me.timeZone).slice(0, 7)}-01`);
  const [data, setData] = useState<ExpenseList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spentOn, setSpentOn] = useState(() => today(me.timeZone));
  const [category, setCategory] = useState<Category>('materials');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [ruleCategory, setRuleCategory] = useState<Category>('rent');
  const [ruleAmount, setRuleAmount] = useState('');
  const [ruleDay, setRuleDay] = useState(1);
  const [ruleNote, setRuleNote] = useState('');

  const load = useCallback(async () => {
    const r = await api<ExpenseList>('GET', `/expenses?from=${month}&to=${addMonths(month, 1)}`);
    setData(r.data ?? null);
    setError(r.ok ? null : t('pwa.error'));
  }, [month, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const label = (c: Category) => t(`expense.${c}` as MessageKey);
  const money = (n: number) => formatMoney(n, locale);

  async function add() {
    const value = parseAmount(amount);
    if (value === null) return setError(t('pwa.error'));
    const r = await api('POST', '/expenses', { spentOn, category, amount: value, ...(note.trim() && { note: note.trim() }) });
    if (!r.ok) return setError(t('pwa.error'));
    setAmount('');
    setNote('');
    await load();
  }

  async function addRule() {
    const value = parseAmount(ruleAmount);
    if (value === null) return setError(t('pwa.error'));
    const r = await api('POST', '/expenses/recurring', {
      category: ruleCategory,
      amount: value,
      dayOfMonth: ruleDay,
      startsOn: month,
      ...(ruleNote.trim() && { note: ruleNote.trim() }),
    });
    if (!r.ok) return setError(t('pwa.error'));
    setRuleAmount('');
    setRuleNote('');
    await load();
  }

  async function remove(id: string) {
    if (!(await api('DELETE', `/expenses/${id}`)).ok) setError(t('pwa.error'));
    await load();
  }

  async function stop(id: string) {
    if (!(await api('POST', `/expenses/recurring/${id}/stop`)).ok) setError(t('pwa.error'));
    await load();
  }

  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}T12:00:00Z`));
  const rows = [
    ...(data?.items ?? []).map((e) => ({ key: e.id, date: e.spentOn, category: e.category, amount: e.amount, note: e.note, id: e.id as string | null })),
    ...(data?.charges ?? []).map((c) => ({ key: `${c.recurringId}-${c.chargedOn}`, date: c.chargedOn, category: c.category, amount: c.amount, note: c.note, id: null })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <main>
      <h1>{t('pwa.exp.title')}</h1>
      <div className="daynav">
        <button type="button" className="secondary" aria-label="‹" onClick={() => setMonth(addMonths(month, -1))}>
          ‹
        </button>
        <strong>{monthLabel}</strong>
        <button type="button" className="secondary" aria-label="›" onClick={() => setMonth(addMonths(month, 1))}>
          ›
        </button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {data && (
        <div className="card">
          <p className="stat">{t('pwa.exp.total', { amount: money(data.totals.total) })}</p>
          {CATEGORIES.filter((c) => data.totals.byCategory[c]).map((c) => (
            <div key={c} className="link-row">
              <span>{label(c)}</span>
              <span>{money(data.totals.byCategory[c]!)} zł</span>
            </div>
          ))}
        </div>
      )}

      {data && rows.length === 0 && <p className="muted">{t('pwa.exp.empty')}</p>}
      {rows.map((r) => (
        <div key={r.key} className="card link-row">
          <span>
            <strong>{money(r.amount)} zł</strong> · {label(r.category)}
            {r.id === null && <span className="badge"> {t('pwa.exp.monthly_badge')}</span>}
            <div className="muted">
              {r.date}
              {r.note && ` · ${r.note}`}
            </div>
          </span>
          {r.id && (
            <button type="button" className="chip" aria-label={t('pwa.client.delete_note')} onClick={() => void remove(r.id!)}>
              ×
            </button>
          )}
        </div>
      ))}

      <section>
        <h2>{t('pwa.exp.add')}</h2>
        <div className="row">
          <div>
            <label htmlFor="exp-date">{t('pwa.exp.date')}</label>
            <input id="exp-date" type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
          </div>
          <div>
            <label htmlFor="exp-amount">{t('pwa.exp.amount')}</label>
            <input id="exp-amount" type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <label htmlFor="exp-category">{t('pwa.exp.category')}</label>
        <select id="exp-category" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {label(c)}
            </option>
          ))}
        </select>
        <label htmlFor="exp-note">{t('pwa.exp.note')}</label>
        <input id="exp-note" type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="primary" disabled={parseAmount(amount) === null || !spentOn} onClick={() => void add()}>
          {t('pwa.exp.add')}
        </button>
      </section>

      <section>
        <h2>{t('pwa.exp.recurring')}</h2>
        {(data?.recurring ?? []).map((r) => (
          <div key={r.id} className="card">
            <strong>{label(r.category)}</strong> · {t('pwa.exp.monthly_line', { amount: money(r.amount), day: r.dayOfMonth })}
            {r.note && <div className="muted">{r.note}</div>}
            <div className="muted">
              {r.startsOn}
              {r.endsOn ? ` – ${r.endsOn}` : ' – …'}
            </div>
            {!r.endsOn && (
              <button type="button" className="chip" onClick={() => void stop(r.id)}>
                {t('pwa.exp.stop')}
              </button>
            )}
          </div>
        ))}
        <div className="row">
          <div>
            <label htmlFor="rule-category">{t('pwa.exp.category')}</label>
            <select id="rule-category" value={ruleCategory} onChange={(e) => setRuleCategory(e.target.value as Category)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="rule-amount">{t('pwa.exp.amount')}</label>
            <input id="rule-amount" type="text" inputMode="decimal" value={ruleAmount} onChange={(e) => setRuleAmount(e.target.value)} />
          </div>
        </div>
        <label htmlFor="rule-day">{t('pwa.exp.day_of_month')}</label>
        <select id="rule-day" value={ruleDay} onChange={(e) => setRuleDay(Number(e.target.value))}>
          {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <label htmlFor="rule-note">{t('pwa.exp.note')}</label>
        <input id="rule-note" type="text" maxLength={500} value={ruleNote} onChange={(e) => setRuleNote(e.target.value)} />
        <button type="button" className="secondary" disabled={parseAmount(ruleAmount) === null} onClick={() => void addRule()}>
          {t('pwa.exp.recurring_add')}
        </button>
      </section>

      <p className="muted">{t('pwa.exp.disclaimer')}</p>
    </main>
  );
}
