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
};
