import { LOCALES, daysInBirthMonth, formatBirthdayValue, monthName, parseBirthday, type Locale } from '@rezerwapp/shared';
import { useState } from 'react';
import { api, type Me } from '../api';
import { LANGUAGE_NAMES, useT } from '../i18n';
import { go } from '../router';

/**
 * День рождения без года (D-065): месяц и день отдельными списками, дни по выбранному месяцу (29 февраля можно).
 * value: "MM-DD" или null; неполный выбор (только месяц) считается пустым.
 */
export function BirthdayInput({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const { t, locale } = useT();
  const parsed = value ? parseBirthday(value) : null;
  const [month, setMonth] = useState(parsed?.month ?? 0);
  const [day, setDay] = useState(parsed?.day ?? 0);

  const update = (m: number, d: number) => {
    const fixedDay = m && d > daysInBirthMonth(m) ? 0 : d;
    setMonth(m);
    setDay(fixedDay);
    onChange(m && fixedDay ? formatBirthdayValue({ month: m, day: fixedDay }) : null);
  };

  return (
    <div className="row birthday">
      <select aria-label={t('pwa.client.month')} value={month} onChange={(e) => update(Number(e.target.value), day)}>
        <option value={0}>{t('pwa.client.month')}</option>
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
          <option key={m} value={m}>
            {monthName(m, locale)}
          </option>
        ))}
      </select>
      <select aria-label={t('pwa.client.day')} value={day} onChange={(e) => update(month, Number(e.target.value))}>
        <option value={0}>{t('pwa.client.day')}</option>
        {Array.from({ length: month ? daysInBirthMonth(month) : 31 }, (_, i) => i + 1).map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Клиент вручную (D-065): позвонил, написал, пришёл с улицы. Номер уже в базе: открывается его карточка
 * (CLIENT_EXISTS) или, у сотрудника салона, клиент другого мастера привязывается и к нему (linked).
 * У сотрудника (staff) клиент попадает в базу бизнеса, на который он работает: подсказка в форме.
 */
export function NewClient({ me }: { me: Me }) {
  const { t, locale } = useT();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [language, setLanguage] = useState<Locale>(locale);
  const [birthday, setBirthday] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canNotes = me.role !== 'assistant';

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api<{ id: string; linked: boolean }>('POST', '/clients', {
      name,
      phone,
      language,
      ...(email.trim() && { email: email.trim() }),
      ...(birthday && { birthday }),
    });
    setBusy(false);
    if (r.ok && r.data) {
      if (!r.data.linked && canNotes && note.trim()) await api('POST', `/clients/${r.data.id}/notes`, { body: note.trim() });
      go(`clients/${r.data.id}${r.data.linked ? '/linked' : ''}`);
    } else if (r.error === 'CLIENT_EXISTS' && typeof r.details?.clientId === 'string') {
      go(`clients/${r.details.clientId}/exists`);
    } else {
      setError(t(r.error === 'VALIDATION' ? 'pwa.client.invalid_phone' : r.error === 'OFFLINE' ? 'pwa.offline' : 'pwa.error'));
    }
  }

  return (
    <main>
      <h1>{t('pwa.clients.add')}</h1>
      {me.role === 'staff' && <p className="notice">{t('pwa.client.salon_hint', { business: me.accountName })}</p>}
      <form onSubmit={(e) => void save(e)}>
        <label htmlFor="c-name">{t('widget.name')}</label>
        <input id="c-name" type="text" autoComplete="off" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} required />
        <label htmlFor="c-phone">{t('widget.phone')}</label>
        <input id="c-phone" type="tel" inputMode="tel" autoComplete="off" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} required />
        <label htmlFor="c-email">{t('pwa.client.email')}</label>
        <input id="c-email" type="email" autoComplete="off" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="c-lang">{t('pwa.client.language')}</label>
        <select id="c-lang" value={language} onChange={(e) => setLanguage(e.target.value as Locale)}>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_NAMES[l]}
            </option>
          ))}
        </select>
        <label>{t('pwa.client.birthday')}</label>
        <BirthdayInput value={birthday} onChange={setBirthday} />
        <p className="muted">{t('pwa.client.birthday_hint')}</p>
        {canNotes && (
          <>
            <label htmlFor="c-note">{t('pwa.client.note')}</label>
            <textarea id="c-note" maxLength={5000} value={note} onChange={(e) => setNote(e.target.value)} />
            <p className="muted">{t('notes.health_warning')}</p>
          </>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy || !name.trim() || !phone.trim()}>
          {t('pwa.set.save')}
        </button>
      </form>
    </main>
  );
}
