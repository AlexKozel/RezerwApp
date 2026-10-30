import { Logger } from '@nestjs/common';
import { isLocale, t, type BookingStatus, type Locale, type MessageKey, type MessageParams } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';
import type { FieldCipher } from '../crypto/field-cipher';
import type { Db } from '../db/db';
import { dedupeKey, notifySafely, type BookingNotification, type Notifier } from '../jobs/notifier';
import { birthdaysBetween } from '../clients/crm.service';
import type { ManageTokens } from '../public/manage-token';
import { OFFER_MINUTES } from '../waitlist/waitlist.service';
import { CHANNEL_ORDER, type Channel, type ChannelAdapter, type Contact } from './channels';
import { SMS_WARN_PERCENT, chargeSms, smsUsage } from './sms-quota';

type DeliveryStatus = 'sent' | 'sandbox' | 'skipped' | 'failed';

interface Delivery {
  kind: 'client' | 'user';
  id: string;
  language: Locale;
  template: MessageKey;
  params: MessageParams;
  contact: Contact;
  subjectMaster: string;
  /** Дописать к тексту инструкцию оплаты (BOOKING_FLOW.md, раздел 4). */
  feeInstruction?: MessageParams;
}

export interface DeliveryResult {
  kind: 'client' | 'user';
  id: string;
  template: MessageKey;
  status: DeliveryStatus | 'queued';
  channel: Channel | null;
}

interface BookingContext {
  id: string;
  status: BookingStatus;
  starts_at: Date;
  staff_name: string;
  public_slug: string;
  staff_user_id: string | null;
  service_name: Record<string, string>;
  client_id: string;
  client_name: string;
  client_language: string;
  client_email: string | null;
  phone_encrypted: Buffer;
  anonymized_at: Date | null;
  account_locale: string;
  account_name: string;
  timezone: string;
  blik_phone: string | null;
  pay_amount: string | null;
  pay_code: string | null;
}

const INTL_LOCALE: Record<Locale, string> = { pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' };

export function formatWhen(at: Date, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

function lang(value: string): Locale {
  return isLocale(value) ? value : 'pl';
}

function pick(texts: Record<string, string>, locale: Locale): string {
  return texts[locale] ?? texts.pl ?? Object.values(texts)[0] ?? '';
}

/**
 * Доставка уведомлений (D-035, D-052). Событие содержит только id; данные читаются под RLS Account в момент
 * доставки. Каждый получатель обрабатывается в своей транзакции: строка notification_log блокируется
 * (FOR UPDATE), поэтому повтор задачи или второй воркер не отправят сообщение дважды. Каналы перебираются
 * по приоритету D-035 до первой успешной отправки. Если у кого-то все каналы упали, dispatch бросает
 * исключение, и очередь повторит задачу (успешные доставки при повторе пропускаются).
 */
export class NotificationDispatcher {
  private readonly channels: ChannelAdapter[];
  private readonly logger = new Logger('NotificationDispatcher');

  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher,
    private readonly tokens: ManageTokens,
    channels: ChannelAdapter[],
    private readonly publicUrl: string,
    /** Для предупреждения о лимите SMS (событие ставится в ту же очередь). */
    private readonly notifier?: Notifier,
  ) {
    this.channels = [...channels].sort((a, b) => CHANNEL_ORDER.indexOf(a.channel) - CHANNEL_ORDER.indexOf(b.channel));
  }

  async dispatch(event: BookingNotification): Promise<DeliveryResult[]> {
    const deliveries = await this.db.withAccount(event.accountId, (client) => this.plan(client, event));
    const results: DeliveryResult[] = [];
    for (const d of deliveries) results.push(await this.deliver(event, d));
    const failed = results.filter((r) => r.status === 'failed').length;
    if (failed > 0) throw new Error(`${failed} of ${results.length} deliveries failed for ${dedupeKey(event)}`);
    return results;
  }

  /** Кому и что отправить по событию. Устаревшие события (статус уже другой) не отправляются. */
  private async plan(client: PoolClient, event: BookingNotification): Promise<Delivery[]> {
    if (event.type === 'account.sms_quota') {
      const account = (await client.query<{ name: string; locale: string }>('SELECT name, locale FROM accounts')).rows[0];
      if (!account) return [];
      return (await this.owners(client)).map((u) => ({
        kind: 'user',
        id: u.id,
        language: lang(account.locale),
        template: 'notify.master.sms_quota',
        params: { percent: event.percent },
        contact: { email: u.email, phone: null },
        subjectMaster: account.name,
      }));
    }

    if (event.type === 'account.birthdays') return this.birthdayReminders(client, event.date);
    if (event.type === 'waitlist.joined' || event.type === 'waitlist.offer') return this.waitlistDeliveries(client, event);

    const b = await this.booking(client, event.bookingId);
    if (!b) return [];
    const clientLang = lang(b.client_language);
    const masterLang = lang(b.account_locale);
    const manageLink = `${this.publicUrl}/b/${this.tokens.issue(event.accountId, b.id)}`;
    const pageLink = `${this.publicUrl}/${b.public_slug}`;
    const phone = b.anonymized_at ? null : await this.decryptPhone(client, event.accountId, b);

    const toClient = (template: MessageKey, link: string, extra: Partial<Delivery> = {}): Delivery => ({
      kind: 'client',
      id: b.client_id,
      language: clientLang,
      template,
      params: { service: pick(b.service_name, clientLang), master: b.staff_name, date: formatWhen(b.starts_at, b.timezone, clientLang), link },
      contact: { email: b.anonymized_at ? null : b.client_email, phone },
      subjectMaster: b.staff_name,
      ...extra,
    });
    const toMasters = async (template: MessageKey): Promise<Delivery[]> =>
      (await this.masters(client, b.staff_user_id)).map((u) => ({
        kind: 'user',
        id: u.id,
        language: masterLang,
        template,
        params: { service: pick(b.service_name, masterLang), date: formatWhen(b.starts_at, b.timezone, masterLang), client: b.client_name },
        contact: { email: u.email, phone: null },
        subjectMaster: b.staff_name,
      }));

    switch (event.type) {
      case 'booking.created': {
        // По статусу на момент создания: если мастер успел подтвердить, об этом скажет status_changed.
        if (event.status === 'pending') {
          const fee = b.pay_code && b.blik_phone ? { amount: Number(b.pay_amount), phone: b.blik_phone, code: b.pay_code } : undefined;
          return [toClient('notify.client.request_received', manageLink, { feeInstruction: fee }), ...(await toMasters('notify.master.new_request'))];
        }
        if (event.status === 'confirmed') return [toClient('notify.client.confirmed', manageLink), ...(await toMasters('notify.master.new_booking'))];
        return [];
      }
      case 'booking.status_changed':
        if (b.status !== event.to) return [];
        if (event.to === 'confirmed') return [toClient('notify.client.confirmed', manageLink)];
        if (event.to === 'rejected') return [toClient('notify.client.rejected', pageLink)];
        if (event.to === 'cancelled_by_master') return [toClient('notify.client.cancelled_by_master', pageLink)];
        return [];
      case 'booking.expired':
        return b.status === 'expired' ? [toClient('notify.client.expired', pageLink)] : [];
      case 'booking.master_reminder':
        return b.status === 'pending' ? toMasters('notify.master.reminder') : [];
      case 'booking.client_reminder':
        return b.status === 'confirmed' ? [toClient('notify.client.reminder', manageLink)] : [];
      case 'booking.cancelled_by_client':
        return toMasters('notify.master.cancelled_by_client');
      case 'booking.rescheduled':
        return [toClient('notify.client.rescheduled', manageLink), ...(await toMasters('notify.master.rescheduled'))];
    }
  }

  private async deliver(event: BookingNotification, d: Delivery): Promise<DeliveryResult> {
    const key = dedupeKey(event);
    const bookingId = 'bookingId' in event ? event.bookingId : null;
    let quotaEvent: BookingNotification | null = null;

    const result = await this.db.withAccount(event.accountId, async (client): Promise<DeliveryResult> => {
      await client.query(
        `INSERT INTO notification_log (account_id, booking_id, dedupe_key, recipient_kind, recipient_id, template, language)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id, dedupe_key, recipient_kind, recipient_id) DO NOTHING`,
        [event.accountId, bookingId, key, d.kind, d.id, d.template, d.language],
      );
      const log = (await client.query<{ id: string; status: DeliveryResult['status']; channel: Channel | null }>(
        `SELECT id, status, channel FROM notification_log
          WHERE dedupe_key = $1 AND recipient_kind = $2 AND recipient_id = $3 FOR UPDATE`,
        [key, d.kind, d.id],
      )).rows[0]!;
      const done = { kind: d.kind, id: d.id, template: d.template };
      if (log.status !== 'queued' && log.status !== 'failed') return { ...done, status: log.status, channel: log.channel };

      let text = t(d.language, d.template, d.params);
      if (d.feeInstruction) text += ` ${t(d.language, 'booking.fee.instruction', d.feeInstruction)}`;
      const message = { to: d.contact, language: d.language, subject: t(d.language, 'notify.subject', { master: d.subjectMaster }), text, template: d.template, logId: log.id };

      let outcome: { status: DeliveryStatus; channel: Channel | null; reason: string | null; cost: number | null } = {
        status: 'skipped',
        channel: null,
        reason: 'no_contact',
        cost: null,
      };
      for (const adapter of this.channels) {
        if (!adapter.reachable(d.contact)) continue;
        const paidSms = adapter.channel === 'sms' && !adapter.sandbox;
        if (paidSms && (await smsUsage(client)).remaining <= 0) {
          outcome = { status: 'skipped', channel: null, reason: 'sms_quota', cost: null };
          continue;
        }
        try {
          const sent = await adapter.send(message);
          outcome = { status: adapter.sandbox ? 'sandbox' : 'sent', channel: adapter.channel, reason: null, cost: sent.cost };
          if (paidSms) {
            const before = (await smsUsage(client)).percent;
            const after = await chargeSms(client, event.accountId, d.template);
            if (before < SMS_WARN_PERCENT && after.percent >= SMS_WARN_PERCENT) {
              quotaEvent = { type: 'account.sms_quota', accountId: event.accountId, month: new Date().toISOString().slice(0, 7), percent: after.percent };
            }
          }
          break;
        } catch (error) {
          // Текст ошибки провайдера может содержать номер или адрес: в журнал идёт только тип ошибки.
          outcome = { status: 'failed', channel: adapter.channel, reason: (error as Error).name || 'Error', cost: null };
        }
      }

      await client.query(
        `UPDATE notification_log SET status = $2, channel = $3, reason = $4, cost = $5, attempts = attempts + 1,
                                     sent_at = CASE WHEN $2 IN ('sent', 'sandbox') THEN now() END
          WHERE id = $1`,
        [log.id, outcome.status, outcome.channel, outcome.reason, outcome.cost],
      );
      return { ...done, status: outcome.status, channel: outcome.channel };
    });

    if (quotaEvent) await notifySafely(this.notifier, quotaEvent);
    return result;
  }

  /**
   * Повреждённый шифротекст (или ключ не того провайдера) не должен блокировать остальные доставки события:
   * телефон считается недоступным, ошибка логируется без данных клиента.
   */
  private async decryptPhone(client: PoolClient, accountId: string, b: Pick<BookingContext, 'client_id' | 'phone_encrypted'>): Promise<string | null> {
    try {
      return await this.cipher.decrypt(client, accountId, b.phone_encrypted);
    } catch (error) {
      this.logger.error(`client ${b.client_id}: phone cannot be decrypted (${(error as Error).message})`);
      return null;
    }
  }

  private async booking(client: PoolClient, bookingId: string): Promise<BookingContext | undefined> {
    return (await client.query<BookingContext>(
      `SELECT b.id, b.status, b.starts_at, st.display_name AS staff_name, st.public_slug, st.user_id AS staff_user_id,
              sv.name_i18n AS service_name, c.id AS client_id, c.name AS client_name, c.language AS client_language,
              c.email AS client_email, c.phone_encrypted, c.anonymized_at,
              a.locale AS account_locale, a.name AS account_name, a.timezone, a.blik_phone,
              pr.amount AS pay_amount, pr.code AS pay_code
         FROM bookings b
         JOIN staff st ON st.id = b.staff_id
         JOIN services sv ON sv.id = b.service_id
         JOIN clients c ON c.id = b.client_id
         JOIN accounts a ON a.id = b.account_id
         LEFT JOIN payment_requests pr ON pr.booking_id = b.id
        WHERE b.id = $1`,
      [bookingId],
    )).rows[0];
  }

  /** Мастеру: пользователь, привязанный к специалисту, иначе владельцы Account. */
  private async masters(client: PoolClient, staffUserId: string | null): Promise<Array<{ id: string; email: string }>> {
    if (staffUserId) {
      const linked = await client.query<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = $1', [staffUserId]);
      if (linked.rows.length > 0) return linked.rows;
    }
    return this.owners(client);
  }

  /**
   * Именинники дня каждому мастеру: владельцам все клиенты Account, сотрудникам (staff) только свои (D-050, D-065).
   * assistant не получает: поздравлять клиента будет мастер. Кому некого поздравить, тому не отправляется.
   */
  private async birthdayReminders(client: PoolClient, date: string): Promise<Delivery[]> {
    const account = (await client.query<{ name: string; locale: string }>('SELECT name, locale FROM accounts')).rows[0];
    if (!account) return [];
    const users = await client.query<{ id: string; email: string; role: string; staff_ids: string[] }>(
      `SELECT u.id, u.email, u.role, COALESCE(array_agg(st.id) FILTER (WHERE st.id IS NOT NULL), '{}') AS staff_ids
         FROM users u LEFT JOIN staff st ON st.user_id = u.id
        WHERE u.role IN ('owner', 'staff')
        GROUP BY u.id ORDER BY u.created_at`,
    );
    const deliveries: Delivery[] = [];
    for (const u of users.rows) {
      if (u.role === 'staff' && u.staff_ids.length === 0) continue;
      const people = await birthdaysBetween(client, date, 1, u.role === 'owner' ? null : u.staff_ids);
      if (people.length === 0) continue;
      deliveries.push({
        kind: 'user',
        id: u.id,
        language: lang(account.locale),
        template: 'notify.master.birthdays',
        params: { names: people.map((p) => p.name).join(', ') },
        contact: { email: u.email, phone: null },
        subjectMaster: account.name,
      });
    }
    return deliveries;
  }

  /**
   * Лист ожидания (D-068): подтверждение постановки со ссылкой выхода и предложение освободившегося слота со
   * ссылкой на запись (услуга и день выбраны). Клиент уже не ждёт или предложение истекло: не отправляется.
   */
  private async waitlistDeliveries(
    client: PoolClient,
    event: Extract<BookingNotification, { type: 'waitlist.joined' | 'waitlist.offer' }>,
  ): Promise<Delivery[]> {
    let entryId: string;
    let offer: { starts_at: Date; expires_at: Date } | null = null;
    if (event.type === 'waitlist.offer') {
      const row = (await client.query<{ entry_id: string; starts_at: Date; expires_at: Date }>(
        'SELECT entry_id, starts_at, expires_at FROM waitlist_offers WHERE id = $1',
        [event.offerId],
      )).rows[0];
      if (!row || row.expires_at <= new Date()) return [];
      entryId = row.entry_id;
      offer = row;
    } else {
      entryId = event.entryId;
    }
    const e = (await client.query<{
      status: string;
      service_id: string;
      variant_id: string;
      staff_name: string;
      public_slug: string;
      service_name: Record<string, string>;
      client_id: string;
      client_language: string;
      client_email: string | null;
      phone_encrypted: Buffer;
      anonymized_at: Date | null;
      timezone: string;
    }>(
      `SELECT e.status, e.service_id, e.variant_id, st.display_name AS staff_name, st.public_slug, sv.name_i18n AS service_name,
              c.id AS client_id, c.language AS client_language, c.email AS client_email, c.phone_encrypted, c.anonymized_at, a.timezone
         FROM waitlist_entries e
         JOIN staff st ON st.id = e.staff_id
         JOIN services sv ON sv.id = e.service_id
         JOIN clients c ON c.id = e.client_id
         JOIN accounts a ON a.id = e.account_id
        WHERE e.id = $1`,
      [entryId],
    )).rows[0];
    if (!e || e.status !== 'waiting' || e.anonymized_at) return [];
    const language = lang(e.client_language);
    const params: Record<string, string | number> = { master: e.staff_name, service: pick(e.service_name, language) };
    let template: MessageKey;
    if (offer) {
      template = 'notify.client.waitlist_offer';
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: e.timezone }).format(offer.starts_at);
      params.date = formatWhen(offer.starts_at, e.timezone, language);
      params.minutes = OFFER_MINUTES;
      params.link = `${this.publicUrl}/${e.public_slug}?service=${e.service_id}&variant=${e.variant_id}&date=${day}&lang=${language}`;
    } else {
      template = 'notify.client.waitlist_joined';
      params.link = `${this.publicUrl}/w/${this.tokens.issueWaitlist(event.accountId, entryId)}`;
    }
    return [
      {
        kind: 'client',
        id: e.client_id,
        language,
        template,
        params,
        contact: { email: e.client_email, phone: await this.decryptPhone(client, event.accountId, e) },
        subjectMaster: e.staff_name,
      },
    ];
  }

  private async owners(client: PoolClient): Promise<Array<{ id: string; email: string }>> {
    return (await client.query<{ id: string; email: string }>("SELECT id, email FROM users WHERE role = 'owner' ORDER BY created_at")).rows;
  }
}
