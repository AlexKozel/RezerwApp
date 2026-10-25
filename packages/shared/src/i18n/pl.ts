/**
 * Польский: эталонный набор ключей и юридически приоритетная версия (ARCHITECTURE.md, раздел 8).
 * Тексты согласий и оплаты это черновики для проверки юристом (LEGAL_CHECKLIST.md).
 * Слово «zadatek» в интерфейсе не используется (D-011).
 */
export const pl = {
  'booking.status.pending': 'Oczekuje na potwierdzenie',
  'booking.status.confirmed': 'Potwierdzona',
  'booking.status.rejected': 'Odrzucona',
  'booking.status.expired': 'Wygasła',
  'booking.status.cancelled_by_client': 'Odwołana przez klienta',
  'booking.status.cancelled_by_master': 'Odwołana przez specjalistę',
  'booking.status.completed': 'Zrealizowana',
  'booking.status.no_show': 'Nieobecność',
  'booking.status.rescheduled': 'Przełożona',
  'booking.fee.label': 'Opłata rezerwacyjna',
  'booking.fee.instruction':
    'Aby potwierdzić rezerwację, wpłać {amount} PLN przez BLIK na numer {phone}. W tytule wpisz kod: {code}.',
  'booking.error.slot_taken': 'Ten termin został właśnie zajęty. Wybierz inny.',
  'booking.hold.expired': 'Czas na potwierdzenie rezerwacji minął. Wybierz termin ponownie.',
  'booking.cancel.free_until': 'Bezpłatna zmiana lub odwołanie do {hours} godz. przed wizytą.',
  'booking.cancel.contact': 'Skontaktuj się ze specjalistą',
  'booking.reschedule': 'Przełóż termin',
  'client.no_free_slots': 'Brak wolnych terminów.',
  'notes.health_warning':
    'Nie wpisuj danych o stanie zdrowia (np. alergie, choroby), jeśli klient nie wyraził na to zgody.',
  'consent.health':
    'Wyrażam zgodę na przetwarzanie moich danych o stanie zdrowia (np. alergie) przez {master} w celu bezpiecznego wykonania usługi.',
  // Уведомления (BOOKING_FLOW.md, раздел 6). Без слова «zadatek» (D-011).
  'notify.subject':
    'RezerwApp: {master}',
  'notify.client.request_received':
    'Zgłoszenie przyjęte: {service} u {master}, {date}. Czekamy na potwierdzenie specjalisty. Zarządzaj rezerwacją: {link}',
  'notify.client.confirmed':
    'Rezerwacja potwierdzona: {service} u {master}, {date}. Zmiana lub odwołanie: {link}',
  'notify.client.rejected':
    'Specjalista {master} nie może przyjąć rezerwacji na {date}. Wybierz inny termin: {link}',
  'notify.client.expired':
    'Czas na potwierdzenie rezerwacji na {date} u {master} minął. Wybierz nowy termin: {link}',
  'notify.client.cancelled_by_master':
    'Wizyta {date} u {master} została odwołana przez specjalistę. Opłata rezerwacyjna, jeśli była wpłacona, zostanie zwrócona. Nowy termin: {link}',
  'notify.client.reminder':
    'Przypomnienie: {service} u {master}, {date}. Zmiana terminu lub kontakt: {link}',
  'notify.client.rescheduled':
    'Termin zmieniony: {service} u {master}, nowy termin {date}. Zarządzaj rezerwacją: {link}',
  'notify.master.new_request':
    'Nowe zgłoszenie: {service}, {date}, klient {client}. Potwierdź lub odrzuć w aplikacji.',
  'notify.master.new_booking':
    'Nowa rezerwacja: {service}, {date}, klient {client}.',
  'notify.master.reminder':
    'Zgłoszenie na {date} (klient {client}) czeka na odpowiedź od 30 minut.',
  'notify.master.cancelled_by_client':
    'Klient {client} odwołał wizytę {date}.',
  'notify.master.rescheduled':
    'Klient {client} przeniósł wizytę na {date}.',
  'notify.master.sms_quota':
    'Wykorzystano {percent}% limitu SMS w tym miesiącu.',
  // Виджет записи клиента (apps/widget).
  'widget.choose_service': 'Wybierz usługę',
  'widget.choose_time': 'Wybierz termin',
  'widget.no_slots': 'Brak wolnych terminów w tych dniach.',
  'widget.duration': '{minutes} min',
  'widget.price': '{price} zł',
  'widget.fee': 'Opłata rezerwacyjna: {amount} zł',
  'widget.fee_percent': 'Opłata rezerwacyjna: {percent}% ceny',
  'widget.fee_new_clients': 'dla nowych klientów',
  'widget.your_details': 'Twoje dane',
  'widget.name': 'Imię',
  'widget.phone': 'Telefon',
  'widget.send_code': 'Wyślij kod',
  'widget.code': 'Kod z SMS',
  'widget.code_sent': 'Kod został wysłany.',
  'widget.accept_terms': 'Akceptuję regulamin usług',
  'widget.accept_privacy': 'Zapoznałam/em się z informacją o przetwarzaniu danych',
  'widget.read': 'przeczytaj',
  'widget.book': 'Zarezerwuj',
  'widget.book_with_fee': 'Rezerwuję z obowiązkiem opłaty',
  'widget.result_pending': 'Zgłoszenie wysłane. Specjalista potwierdzi rezerwację.',
  'widget.result_confirmed': 'Rezerwacja potwierdzona.',
  'widget.hold_left': 'Czas na potwierdzenie: {time}',
  'widget.manage': 'Zarządzaj rezerwacją',
  'widget.back': 'Wstecz',
  'widget.cancel': 'Odwołaj wizytę',
  'widget.cancel_confirm': 'Na pewno odwołać wizytę?',
  'widget.cancel_late': 'To odwołanie po terminie: opłata rezerwacyjna nie zostanie zwrócona.',
  'widget.cancelled': 'Wizyta odwołana.',
  'widget.reschedule_choose': 'Wybierz nowy termin',
  'widget.rescheduled': 'Termin zmieniony.',
  'widget.when': 'Termin',
  'widget.studio_staff': 'Specjaliści',
  'widget.error.generic': 'Coś poszło nie tak. Spróbuj ponownie.',
  'widget.error.otp': 'Nieprawidłowy kod.',
  'widget.error.pending_limit': 'Masz już oczekujące zgłoszenia u tego specjalisty.',
  'widget.error.rate': 'Zbyt wiele prób. Spróbuj później.',
  'widget.error.unavailable': 'Rezerwacja jest chwilowo niedostępna.',
  'widget.not_found': 'Nie znaleziono strony.',
  'widget.language': 'Język',
  'widget.save_link': 'Zapisz ten link, aby zmienić lub odwołać wizytę.',
} as const;

export type MessageKey = keyof typeof pl;
