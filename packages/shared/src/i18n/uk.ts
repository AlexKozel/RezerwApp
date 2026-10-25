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
  'booking.fee.label': 'Резерваційна оплата',
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
  // Виджет записи клиента (apps/widget).
  'widget.choose_service': 'Оберіть послугу',
  'widget.choose_time': 'Оберіть час',
  'widget.no_slots': 'Немає вільного часу в ці дні.',
  'widget.duration': '{minutes} хв',
  'widget.price': '{price} zł',
  'widget.fee': 'Резерваційна оплата: {amount} zł',
  'widget.fee_percent': 'Резерваційна оплата: {percent}% ціни',
  'widget.fee_new_clients': 'для нових клієнтів',
  'widget.your_details': 'Ваші дані',
  'widget.name': 'Ім’я',
  'widget.phone': 'Телефон',
  'widget.send_code': 'Надіслати код',
  'widget.code': 'Код із SMS',
  'widget.code_sent': 'Код надіслано.',
  'widget.accept_terms': 'Приймаю правила надання послуг',
  'widget.accept_privacy': 'Я ознайомилася/ознайомився з інформацією про обробку даних',
  'widget.read': 'читати',
  'widget.book': 'Записатися',
  'widget.book_with_fee': 'Записуюся з обов’язком оплати',
  'widget.result_pending': 'Заявку надіслано. Спеціаліст підтвердить запис.',
  'widget.result_confirmed': 'Запис підтверджено.',
  'widget.hold_left': 'Час на підтвердження: {time}',
  'widget.manage': 'Керувати записом',
  'widget.back': 'Назад',
  'widget.cancel': 'Скасувати візит',
  'widget.cancel_confirm': 'Точно скасувати візит?',
  'widget.cancel_late': 'Це скасування після дедлайну: резерваційну оплату не буде повернуто.',
  'widget.cancelled': 'Візит скасовано.',
  'widget.reschedule_choose': 'Оберіть новий час',
  'widget.rescheduled': 'Час змінено.',
  'widget.when': 'Час',
  'widget.studio_staff': 'Спеціалісти',
  'widget.error.generic': 'Щось пішло не так. Спробуйте ще раз.',
  'widget.error.otp': 'Неправильний код.',
  'widget.error.pending_limit': 'У вас уже є заявки, що очікують, у цього спеціаліста.',
  'widget.error.rate': 'Забагато спроб. Спробуйте пізніше.',
  'widget.error.unavailable': 'Запис тимчасово недоступний.',
  'widget.not_found': 'Сторінку не знайдено.',
  'widget.language': 'Мова',
  'widget.save_link': 'Збережіть це посилання, щоб змінити або скасувати візит.',
};
