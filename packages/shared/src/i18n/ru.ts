import type { MessageKey } from './pl';

export const ru: Record<MessageKey, string> = {
  'booking.status.pending': 'Ожидает подтверждения',
  'booking.status.confirmed': 'Подтверждена',
  'booking.status.rejected': 'Отклонена',
  'booking.status.expired': 'Срок истёк',
  'booking.status.cancelled_by_client': 'Отменена клиентом',
  'booking.status.cancelled_by_master': 'Отменена специалистом',
  'booking.status.completed': 'Выполнена',
  'booking.status.no_show': 'Неявка',
  'booking.status.rescheduled': 'Перенесена',
  'booking.fee.label': 'Оплата за бронирование',
  'booking.fee.instruction':
    'Чтобы подтвердить запись, переведите {amount} PLN через BLIK на номер {phone}. В комментарии укажите код: {code}.',
  'booking.error.slot_taken': 'Это время только что заняли. Выберите другое.',
  'booking.hold.expired': 'Время на подтверждение записи истекло. Выберите время ещё раз.',
  'booking.cancel.free_until': 'Бесплатный перенос или отмена не позднее чем за {hours} ч до визита.',
  'booking.cancel.contact': 'Связаться со специалистом',
  'booking.reschedule': 'Перенести запись',
  'client.no_free_slots': 'Нет свободных мест.',
  'notes.health_warning':
    'Не вносите данные о состоянии здоровья (например, аллергии, болезни), если клиент не дал на это согласия.',
  'consent.health':
    'Я согласен(на) на обработку моих данных о состоянии здоровья (например, аллергий) специалистом {master} для безопасного оказания услуги.',
  // Уведомления (BOOKING_FLOW.md, раздел 6). Без слова «zadatek» (D-011).
  'notify.subject':
    'RezerwApp: {master}',
  'notify.client.request_received':
    'Заявка принята: {service} у {master}, {date}. Ждём подтверждения специалиста. Управление записью: {link}',
  'notify.client.confirmed':
    'Запись подтверждена: {service} у {master}, {date}. Изменить или отменить: {link}',
  'notify.client.rejected':
    'Специалист {master} не может принять запись на {date}. Выберите другое время: {link}',
  'notify.client.expired':
    'Время на подтверждение записи на {date} у {master} истекло. Выберите новое время: {link}',
  'notify.client.cancelled_by_master':
    'Визит {date} у {master} отменён специалистом. Резервационная оплата, если была внесена, будет возвращена. Новое время: {link}',
  'notify.client.reminder':
    'Напоминание: {service} у {master}, {date}. Перенести или связаться: {link}',
  'notify.client.rescheduled':
    'Время изменено: {service} у {master}, новое время {date}. Управление записью: {link}',
  'notify.master.new_request':
    'Новая заявка: {service}, {date}, клиент {client}. Подтвердите или отклоните в приложении.',
  'notify.master.new_booking':
    'Новая запись: {service}, {date}, клиент {client}.',
  'notify.master.reminder':
    'Заявка на {date} (клиент {client}) ждёт ответа уже 30 минут.',
  'notify.master.cancelled_by_client':
    'Клиент {client} отменил визит {date}.',
  'notify.master.rescheduled':
    'Клиент {client} перенёс визит на {date}.',
  'notify.master.sms_quota':
    'Использовано {percent}% лимита SMS в этом месяце.',
};
