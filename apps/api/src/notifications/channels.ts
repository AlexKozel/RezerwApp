import { Logger } from '@nestjs/common';
import type { Locale } from '@rezerwapp/shared';

/** Каналы в порядке приоритета (D-035): Web Push → мессенджеры → email → SMS. */
export const CHANNEL_ORDER = ['push', 'messenger', 'email', 'sms'] as const;
export type Channel = (typeof CHANNEL_ORDER)[number];

export interface Contact {
  email: string | null;
  /** E.164. */
  phone: string | null;
}

export interface OutgoingMessage {
  to: Contact;
  language: Locale;
  subject: string;
  text: string;
  /** Для логов адаптера: шаблон и id записи в notification_log, без текста и контактов. */
  template: string;
  logId: string;
}

/**
 * Канал доставки. Реальные адаптеры (Web Push, Telegram/Messenger/Viber, почтовый и SMS-провайдер)
 * подключаются, когда у владельца появятся аккаунты; до тех пор работает SandboxChannel.
 */
export interface ChannelAdapter {
  readonly channel: Channel;
  /** true: сообщение не уходит провайдеру, статус в журнале sandbox, SMS не списываются. */
  readonly sandbox: boolean;
  reachable(contact: Contact): boolean;
  send(message: OutgoingMessage): Promise<{ cost: number | null }>;
}

/**
 * Песочница: доставка проходит весь путь (выбор канала, лимит SMS, журнал), но сообщение никуда не уходит.
 * В лог пишется только канал, шаблон и id записи журнала: ни текста, ни контактов (ARCHITECTURE.md, раздел 9).
 */
export class SandboxChannel implements ChannelAdapter {
  readonly sandbox = true;
  private readonly logger = new Logger('SandboxChannel');

  constructor(readonly channel: Channel) {}

  reachable(contact: Contact): boolean {
    if (this.channel === 'email') return contact.email !== null;
    if (this.channel === 'sms') return contact.phone !== null;
    return false; // push и мессенджеры требуют подписки клиента, их пока нет
  }

  async send(message: OutgoingMessage): Promise<{ cost: number | null }> {
    this.logger.log(`[sandbox] ${this.channel} ${message.template} log=${message.logId}`);
    return { cost: null };
  }
}
