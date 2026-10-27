'use client';

import { t, type Locale } from '@rezerwapp/shared';
import { useEffect, useMemo, useState } from 'react';
import { clientCall, type BookingResult, type PublicProfile, type PublicService } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { addDays, formatDayLabel, formatMoney, formatTime, formatWhen, groupByDay, localDay, pickText } from '../../lib/format';
import { Countdown } from '../Countdown';

/** Сколько дней вперёд показывать (один запрос слотов; API допускает до 31). */
const DAYS_AHEAD = 14;

type Choice = { service: PublicService; variantId: string };

export function feeLabel(service: PublicService, locale: Locale): string | null {
  const fee = service.bookingFee;
  if (!fee) return null;
  const text = fee.mode === 'percent' ? t(locale, 'widget.fee_percent', { percent: fee.value }) : t(locale, 'widget.fee', { amount: formatMoney(fee.value, locale) });
  return fee.appliesTo === 'new_clients' ? `${text} (${t(locale, 'widget.fee_new_clients')})` : text;
}

/**
 * Запись клиента (BOOKING_FLOW.md, раздел 1): услуга → время → данные, OTP и согласия → результат.
 * Время показывается в поясе Account, а не браузера: клиент едет к мастеру в Варшаву.
 */
export function BookingFlow({ slug, profile, locale }: { slug: string; profile: PublicProfile; locale: Locale }) {
  const tz = profile.timeZone;
  const [choice, setChoice] = useState<Choice | null>(null);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [acceptHealth, setAcceptHealth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BookingResult | null>(null);
  // D-066: мастер требует оплату от клиента с неявками; сумма и путь назад показываются до записи.
  const [deposit, setDeposit] = useState<{ amount: number; visitsLeft: number } | null>(null);
  useEffect(() => setDeposit(null), [choice, slot]);

  // Слоты загружаются при выборе варианта; дни без времени не показываются.
  useEffect(() => {
    if (!choice) return;
    let cancelled = false;
    setSlots(null);
    setDay(null);
    setSlot(null);
    const from = localDay(new Date(), tz);
    const to = addDays(from, DAYS_AHEAD - 1);
    void clientCall<{ slots: string[] }>('GET', `/public/staff/${slug}/slots?variantId=${choice.variantId}&from=${from}&to=${to}`).then((r) => {
      if (cancelled) return;
      setSlots(r.data?.slots ?? []);
      if (!r.ok) setError(errorMessage(r.error, locale));
    });
    return () => {
      cancelled = true;
    };
  }, [choice, slug, tz, locale]);

  const days = useMemo(() => groupByDay(slots ?? [], tz), [slots, tz]);
  const daySlots = days.find((d) => d.day === day)?.slots ?? days[0]?.slots ?? [];
  const activeDay = day ?? days[0]?.day ?? null;

  async function sendCode() {
    setError(null);
    const r = await clientCall('POST', '/public/otp', { phone });
    if (r.ok) setCodeSent(true);
    else setError(errorMessage(r.error, locale));
  }

  async function book(acceptDeposit = false) {
    if (!choice || !slot) return;
    setBusy(true);
    setError(null);
    const r = await clientCall<BookingResult>('POST', `/public/staff/${slug}/bookings`, {
      serviceId: choice.service.id,
      variantId: choice.variantId,
      startsAt: slot,
      name,
      phone,
      language: locale,
      otpCode: code,
      acceptTerms,
      acceptPrivacy,
      acceptHealth,
      acceptDeposit,
    });
    setBusy(false);
    if (r.error === 'DEPOSIT_REQUIRED' && typeof r.details?.amount === 'number' && typeof r.details.visitsLeft === 'number') {
      setDeposit({ amount: r.details.amount, visitsLeft: r.details.visitsLeft });
      return;
    }
    setDeposit(null);
    if (r.ok && r.data) {
      setResult(r.data);
      window.scrollTo({ top: 0 });
      return;
    }
    setError(errorMessage(r.error, locale));
    // Слот заняли, пока клиент заполнял форму: вернуть к выбору времени со свежим списком.
    if (r.error === 'SLOT_NOT_AVAILABLE' || r.error === 'SLOT_TAKEN') setChoice({ ...choice });
  }

  if (result) return <Result result={result} timeZone={tz} locale={locale} />;

  const legal = (type: string) => `/${slug}/legal/${type}?lang=${locale}`;
  const canBook = slot && name.trim() && phone.trim() && code.trim() && acceptTerms && acceptPrivacy && !busy;

  return (
    <>
      <h2>{t(locale, 'widget.choose_service')}</h2>
      {profile.services.map((service) => (
        <section key={service.id} className="card">
          <strong>{pickText(service.name, locale)}</strong>
          {feeLabel(service, locale) && <div className="muted">{feeLabel(service, locale)}</div>}
          {service.variants.map((v) => (
            <button
              key={v.id}
              type="button"
              className="option"
              aria-pressed={choice?.variantId === v.id}
              onClick={() => setChoice({ service, variantId: v.id })}
            >
              <span>
                {pickText(v.name, locale) || pickText(service.name, locale)}
                <span className="muted"> · {t(locale, 'widget.duration', { minutes: v.durationMin })}</span>
              </span>
              <span>{t(locale, 'widget.price', { price: formatMoney(v.price, locale) })}</span>
            </button>
          ))}
        </section>
      ))}

      {choice && (
        <>
          <h2>{t(locale, 'widget.choose_time')}</h2>
          {slots === null ? (
            <p className="muted">…</p>
          ) : days.length === 0 ? (
            <p className="muted">{t(locale, 'widget.no_slots')}</p>
          ) : (
            <>
              <div className="days" role="group">
                {days.map((d) => (
                  <button key={d.day} type="button" className="chip" aria-pressed={d.day === activeDay} onClick={() => setDay(d.day)}>
                    {formatDayLabel(d.day, locale)}
                  </button>
                ))}
              </div>
              <div className="slots" role="group">
                {daySlots.map((s) => (
                  <button key={s.toISOString()} type="button" className="chip" aria-pressed={slot === s.toISOString()} onClick={() => setSlot(s.toISOString())}>
                    {formatTime(s, tz, locale)}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {slot && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void book();
          }}
        >
          <h2>{t(locale, 'widget.your_details')}</h2>
          <p className="muted">{formatWhen(new Date(slot), tz, locale)}</p>
          <label htmlFor="name">{t(locale, 'widget.name')}</label>
          <input id="name" type="text" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} required />
          <label htmlFor="phone">{t(locale, 'widget.phone')}</label>
          <div className="row">
            <input id="phone" type="tel" autoComplete="tel" inputMode="tel" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} required />
            <button type="button" className="secondary" disabled={!phone.trim()} onClick={() => void sendCode()}>
              {t(locale, 'widget.send_code')}
            </button>
          </div>
          {codeSent && <p className="muted">{t(locale, 'widget.code_sent')}</p>}
          <label htmlFor="code">{t(locale, 'widget.code')}</label>
          <input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} required />

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
          <label className="check">
            <input type="checkbox" checked={acceptHealth} onChange={(e) => setAcceptHealth(e.target.checked)} />
            <span>{t(locale, 'consent.health', { master: profile.displayName })}</span>
          </label>

          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {deposit && (
            <div className="notice warn" role="alert">
              <p style={{ margin: 0 }}>{t(locale, 'widget.deposit_required', { amount: formatMoney(deposit.amount, locale) })}</p>
              <p style={{ margin: '8px 0 0' }}>{t(locale, 'widget.deposit_visits_left', { count: deposit.visitsLeft })}</p>
              <button type="button" className="primary" disabled={busy} onClick={() => void book(true)}>
                {t(locale, 'widget.book_with_fee')}
              </button>
            </div>
          )}
          {/* После DEPOSIT_REQUIRED остаётся одна кнопка: запись с обязанностью оплаты. */}
          {!deposit && (
            <button type="submit" className="primary" disabled={!canBook}>
              {t(locale, choice?.service.bookingFee ? 'widget.book_with_fee' : 'widget.book')}
            </button>
          )}
        </form>
      )}
      {!slot && error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** Результат: подтверждено или ждёт мастера (таймер hold), инструкция оплаты BLIK, ссылка управления. */
function Result({ result, timeZone, locale }: { result: BookingResult; timeZone: string; locale: Locale }) {
  const fee = result.bookingFee;
  return (
    <section>
      <p className={`notice ${result.status === 'confirmed' ? 'ok' : 'warn'}`} role="status">
        {t(locale, result.status === 'confirmed' ? 'widget.result_confirmed' : 'widget.result_pending')}
      </p>
      <p>
        <strong>{t(locale, 'widget.when')}:</strong> {formatWhen(new Date(result.startsAt), timeZone, locale)}
      </p>
      {result.holdExpiresAt && <Countdown until={result.holdExpiresAt} locale={locale} />}
      {fee && fee.blikPhone && (
        <div className="card fee">
          <div className="muted">{t(locale, 'booking.fee.label')}</div>
          <p>{t(locale, 'booking.fee.instruction', { amount: formatMoney(fee.amount, locale), phone: fee.blikPhone, code: fee.code })}</p>
          <strong>{fee.code}</strong>
          {fee.recipient && <div className="muted">{fee.recipient}</div>}
          {result.unreliableVisitsLeft !== null && <p className="muted">{t(locale, 'widget.deposit_visits_left', { count: result.unreliableVisitsLeft })}</p>}
        </div>
      )}
      <a className="primary" style={{ textAlign: 'center', textDecoration: 'none' }} href={`/b/${result.manageToken}?lang=${locale}`}>
        {t(locale, 'widget.manage')}
      </a>
      <p className="muted">{t(locale, 'widget.save_link')}</p>
    </section>
  );
}
