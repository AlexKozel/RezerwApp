import type { MessageKey } from './pl';

export const en: Record<MessageKey, string> = {
  'booking.status.pending': 'Awaiting confirmation',
  'booking.status.confirmed': 'Confirmed',
  'booking.status.rejected': 'Declined',
  'booking.status.expired': 'Expired',
  'booking.status.cancelled_by_client': 'Cancelled by client',
  'booking.status.cancelled_by_master': 'Cancelled by specialist',
  'booking.status.completed': 'Completed',
  'booking.status.no_show': 'No-show',
  'booking.status.rescheduled': 'Rescheduled',
  'booking.fee.label': 'Booking fee',
  'booking.fee.instruction':
    'To confirm your booking, send {amount} PLN via BLIK to {phone}. Put this code in the comment: {code}.',
  'booking.error.slot_taken': 'That time was just taken. Please choose another.',
  'booking.hold.expired': 'The time to confirm your booking has run out. Please pick a time again.',
  'booking.cancel.free_until': 'Free rescheduling or cancellation up to {hours} h before your visit.',
  'booking.cancel.contact': 'Contact the specialist',
  'booking.reschedule': 'Reschedule',
  'client.no_free_slots': 'No availability.',
  'notes.health_warning':
    'Do not enter health data (e.g. allergies, illnesses) unless the client has given consent.',
  'consent.health':
    'I consent to {master} processing my health data (e.g. allergies) in order to perform the service safely.',
  // Уведомления (BOOKING_FLOW.md, раздел 6). Без слова «zadatek» (D-011).
  'notify.subject':
    'RezerwApp: {master}',
  'notify.client.request_received':
    'Request received: {service} with {master}, {date}. Waiting for the specialist to confirm. Manage your booking: {link}',
  'notify.client.confirmed':
    'Booking confirmed: {service} with {master}, {date}. Change or cancel: {link}',
  'notify.client.rejected':
    '{master} cannot accept the booking for {date}. Please choose another time: {link}',
  'notify.client.expired':
    'The time to confirm your booking for {date} with {master} has run out. Choose a new time: {link}',
  'notify.client.cancelled_by_master':
    'Your visit on {date} with {master} was cancelled by the specialist. Any booking fee paid will be refunded. New time: {link}',
  'notify.client.reminder':
    'Reminder: {service} with {master}, {date}. Reschedule or get in touch: {link}',
  'notify.client.rescheduled':
    'Time changed: {service} with {master}, new time {date}. Manage your booking: {link}',
  'notify.master.new_request':
    'New request: {service}, {date}, client {client}. Confirm or decline in the app.',
  'notify.master.new_booking':
    'New booking: {service}, {date}, client {client}.',
  'notify.master.reminder':
    'The request for {date} (client {client}) has been waiting for 30 minutes.',
  'notify.master.cancelled_by_client':
    'Client {client} cancelled the visit on {date}.',
  'notify.master.rescheduled':
    'Client {client} moved the visit to {date}.',
  'notify.master.sms_quota':
    '{percent}% of this month’s SMS allowance has been used.',
  // Виджет записи клиента (apps/widget).
  'widget.choose_service': 'Choose a service',
  'widget.choose_time': 'Choose a time',
  'widget.no_slots': 'No free times on these days.',
  'widget.duration': '{minutes} min',
  'widget.price': '{price} zł',
  'widget.fee': 'Booking fee: {amount} zł',
  'widget.fee_percent': 'Booking fee: {percent}% of the price',
  'widget.fee_new_clients': 'for new clients',
  'widget.your_details': 'Your details',
  'widget.name': 'Name',
  'widget.phone': 'Phone',
  'widget.send_code': 'Send code',
  'widget.code': 'Code from SMS',
  'widget.code_sent': 'The code has been sent.',
  'widget.accept_terms': 'I accept the terms of service',
  'widget.accept_privacy': 'I have read the information on data processing',
  'widget.read': 'read',
  'widget.book': 'Book',
  'widget.book_with_fee': 'Book with an obligation to pay',
  'widget.result_pending': 'Request sent. The specialist will confirm your booking.',
  'widget.result_confirmed': 'Booking confirmed.',
  'widget.hold_left': 'Time left to confirm: {time}',
  'widget.manage': 'Manage booking',
  'widget.back': 'Back',
  'widget.cancel': 'Cancel visit',
  'widget.cancel_confirm': 'Cancel this visit?',
  'widget.cancel_late': 'This is a late cancellation: the booking fee will not be refunded.',
  'widget.cancelled': 'Visit cancelled.',
  'widget.reschedule_choose': 'Choose a new time',
  'widget.rescheduled': 'Time changed.',
  'widget.when': 'When',
  'widget.studio_staff': 'Specialists',
  'widget.error.generic': 'Something went wrong. Please try again.',
  'widget.error.otp': 'Incorrect code.',
  'widget.error.pending_limit': 'You already have pending requests with this specialist.',
  'widget.error.rate': 'Too many attempts. Please try later.',
  'widget.error.unavailable': 'Booking is temporarily unavailable.',
  'widget.not_found': 'Page not found.',
  'widget.language': 'Language',
  'widget.save_link': 'Save this link to change or cancel your visit.',
};
