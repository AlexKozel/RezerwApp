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
};
