'use client';

import { t, type Locale, type MessageKey } from '@rezerwapp/shared';
import { useState } from 'react';
import { clientCall } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { addDays, localDay } from '../../lib/format';

const PARTS = ['any', 'morning', 'afternoon', 'evening'] as const;
/** Период по умолчанию: две недели с сегодняшнего дня; API допускает до 31 дня. */
const DEFAULT_DAYS = 14;

/**
 * Лист ожидания (D-068): тот же путь подтверждения, что у записи (код из SMS, согласия), но вместо времени
 * период и часть дня. После постановки ссылка на место в очереди (выйти из листа).
 */
export function WaitlistForm({
  slug,
  serviceId,
  variantId,
  timeZone,
  locale,
}: {
  slug: string;
  serviceId: string;
  variantId: string;
  timeZone: string;
  locale: Locale;
}) {
  const today = localDay(new Date(), timeZone);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, DEFAULT_DAYS - 1));
  const [part, setPart] = useState<(typeof PARTS)[number]>('any');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const legal = (type: string) => `/${slug}/legal/${type}?lang=${locale}`;

  async function sendCode() {
    setError(null);
    const r = await clientCall('POST', '/public/otp', { phone });
    if (r.ok) setCodeSent(true);
    else setError(errorMessage(r.error, locale));
  }

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await clientCall<{ waitlistToken: string }>('POST', `/public/staff/${slug}/waitlist`, {
      serviceId,
      variantId,
      dateFrom: from,
      dateTo: to,
      partOfDay: part,
      name,
      phone,
      language: locale,
      otpCode: code,
      acceptTerms,
      acceptPrivacy,
    });
    setBusy(false);
    if (r.ok && r.data) setToken(r.data.waitlistToken);
    else setError(errorMessage(r.error, locale));
  }

  if (token) {
    return (
      <section className="card">
        <p className="notice ok" role="status">
          {t(locale, 'widget.waitlist_done')}
        </p>
        <a href={`/w/${token}?lang=${locale}`}>{t(locale, 'widget.waitlist_leave')}</a>
        <p className="muted">{t(locale, 'widget.save_link')}</p>
      </section>
    );
  }

  const canJoin = from && to && from <= to && name.trim() && phone.trim() && code.trim() && acceptTerms && acceptPrivacy && !busy;
  return (
    <form className="card" onSubmit={(e) => void join(e)}>
      <h2>{t(locale, 'widget.waitlist_title')}</h2>
      <p className="muted">{t(locale, 'widget.waitlist_hint')}</p>
      <div className="row">
        <div>
          <label htmlFor="wl-from">{t(locale, 'widget.waitlist_from')}</label>
          <input id="wl-from" type="date" min={today} value={from} onChange={(e) => setFrom(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="wl-to">{t(locale, 'widget.waitlist_to')}</label>
          <input id="wl-to" type="date" min={from} max={addDays(from, 30)} value={to} onChange={(e) => setTo(e.target.value)} required />
        </div>
      </div>
      <div className="parts" role="group">
        {PARTS.map((p) => (
          <button key={p} type="button" className="chip" aria-pressed={part === p} onClick={() => setPart(p)}>
            {t(locale, `widget.part_${p}` as MessageKey)}
          </button>
        ))}
      </div>
      <label htmlFor="wl-name">{t(locale, 'widget.name')}</label>
      <input id="wl-name" type="text" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} required />
      <label htmlFor="wl-phone">{t(locale, 'widget.phone')}</label>
      <div className="row">
        <input id="wl-phone" type="tel" autoComplete="tel" inputMode="tel" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} required />
        <button type="button" className="secondary" disabled={!phone.trim()} onClick={() => void sendCode()}>
          {t(locale, 'widget.send_code')}
        </button>
      </div>
      {codeSent && <p className="muted">{t(locale, 'widget.code_sent')}</p>}
      <label htmlFor="wl-code">{t(locale, 'widget.code')}</label>
      <input id="wl-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} required />
      <label className="check">
        <input type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} required />
        <span>
          {t(locale, 'widget.accept_terms')} (<a href={legal('terms')} target="_blank" rel="noopener">{t(locale, 'widget.read')}</a>)
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={acceptPrivacy} onChange={(e) => setAcceptPrivacy(e.target.checked)} required />
        <span>
          {t(locale, 'widget.accept_privacy')} (<a href={legal('privacy')} target="_blank" rel="noopener">{t(locale, 'widget.read')}</a>)
        </span>
      </label>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={!canJoin}>
        {t(locale, 'widget.waitlist_submit')}
      </button>
    </form>
  );
}
