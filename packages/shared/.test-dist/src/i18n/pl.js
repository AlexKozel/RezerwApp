"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pl = void 0;
/**
 * Польский: эталонный набор ключей и юридически приоритетная версия (ARCHITECTURE.md, раздел 8).
 * Тексты согласий и оплаты это черновики для проверки юристом (LEGAL_CHECKLIST.md).
 * Слово «zadatek» в интерфейсе не используется (D-011).
 */
exports.pl = {
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
    'booking.fee.instruction': 'Aby potwierdzić rezerwację, wpłać {amount} PLN przez BLIK na numer {phone}. W tytule wpisz kod: {code}.',
    'booking.error.slot_taken': 'Ten termin został właśnie zajęty. Wybierz inny.',
    'booking.hold.expired': 'Czas na potwierdzenie rezerwacji minął. Wybierz termin ponownie.',
    'booking.cancel.free_until': 'Bezpłatna zmiana lub odwołanie do {hours} godz. przed wizytą.',
    'booking.cancel.contact': 'Skontaktuj się ze specjalistą',
    'booking.reschedule': 'Przełóż termin',
    'client.no_free_slots': 'Brak wolnych terminów.',
    'notes.health_warning': 'Nie wpisuj danych o stanie zdrowia (np. alergie, choroby), jeśli klient nie wyraził na to zgody.',
    'consent.health': 'Wyrażam zgodę na przetwarzanie moich danych o stanie zdrowia (np. alergie) przez {master} w celu bezpiecznego wykonania usługi.',
};
