import type { MessageKey } from './pl';

export const uk: Record<MessageKey, string> = {
  'booking.status.pending': 'Очікує підтвердження',
  'booking.status.confirmed': 'Підтверджено',
  'booking.status.rejected': 'Відхилено',
  'booking.status.expired': 'Термін минув',
  'booking.status.cancelled_by_client': 'Скасовано клієнтом',
  'booking.status.cancelled_by_master': 'Скасовано спеціалістом',
  'booking.status.completed': 'Виконано',
  'booking.status.no_show': 'Неявка',
  'booking.status.rescheduled': 'Перенесено',
  'booking.fee.label': 'Оплата за бронювання',
  'booking.fee.instruction':
    'Щоб підтвердити запис, надішліть {amount} PLN через BLIK на номер {phone}. У коментарі вкажіть код: {code}.',
  'booking.error.slot_taken': 'Цей час щойно зайняли. Оберіть інший.',
  'booking.hold.expired': 'Час на підтвердження запису минув. Оберіть час ще раз.',
  'booking.cancel.free_until': 'Безкоштовна зміна чи скасування не пізніше ніж за {hours} год до візиту.',
  'booking.cancel.contact': 'Зв’язатися зі спеціалістом',
  'booking.reschedule': 'Перенести запис',
  'client.no_free_slots': 'Немає вільних місць.',
  'notes.health_warning':
    'Не вносьте дані про стан здоров’я (напр. алергії, хвороби), якщо клієнт не дав на це згоди.',
  'consent.health':
    'Я погоджуюся на обробку моїх даних про стан здоров’я (напр. алергії) спеціалістом {master} з метою безпечного надання послуги.',
  // Уведомления (BOOKING_FLOW.md, раздел 6). Без слова «zadatek» (D-011).
  'notify.subject':
    'RezerwApp: {master}',
  'notify.client.request_received':
    'Заявку прийнято: {service} у {master}, {date}. Чекаємо на підтвердження спеціаліста. Керування записом: {link}',
  'notify.client.confirmed':
    'Запис підтверджено: {service} у {master}, {date}. Змінити або скасувати: {link}',
  'notify.client.rejected':
    'Спеціаліст {master} не може прийняти запис на {date}. Оберіть інший час: {link}',
  'notify.client.expired':
    'Час на підтвердження запису на {date} у {master} минув. Оберіть новий час: {link}',
  'notify.client.cancelled_by_master':
    'Візит {date} у {master} скасовано спеціалістом. Резерваційну оплату, якщо її було сплачено, буде повернуто. Новий час: {link}',
  'notify.client.reminder':
    'Нагадування: {service} у {master}, {date}. Змінити час або зв’язатися: {link}',
  'notify.client.rescheduled':
    'Час змінено: {service} у {master}, новий час {date}. Керування записом: {link}',
  'notify.master.new_request':
    'Нова заявка: {service}, {date}, клієнт {client}. Підтвердіть або відхиліть у застосунку.',
  'notify.master.new_booking':
    'Новий запис: {service}, {date}, клієнт {client}.',
  'notify.master.reminder':
    'Заявка на {date} (клієнт {client}) чекає на відповідь уже 30 хвилин.',
  'notify.master.cancelled_by_client':
    'Клієнт {client} скасував візит {date}.',
  'notify.master.rescheduled':
    'Клієнт {client} переніс візит на {date}.',
  'notify.master.sms_quota':
    'Використано {percent}% ліміту SMS цього місяця.',
};
