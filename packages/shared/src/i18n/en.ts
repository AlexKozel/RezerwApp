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
};
