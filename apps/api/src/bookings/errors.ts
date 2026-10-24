import type { BookingStatus } from '@rezerwapp/shared';

export class BookingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Слот занят другой записью (ограничение bookings_no_overlap). Клиенту: booking.error.slot_taken. */
export class SlotTakenError extends BookingError {
  constructor() {
    super('SLOT_TAKEN', 'The requested time slot is already taken');
  }
}

export class NotFoundError extends BookingError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`);
  }
}

/** Клиент в blacklist мастера. Наружу показывать нейтрально: client.no_free_slots (BOOKING_FLOW.md, раздел 8). */
export class ClientBlockedError extends BookingError {
  constructor() {
    super('CLIENT_BLOCKED', 'Client is blocked');
  }
}

export class InvalidTransitionError extends BookingError {
  constructor(from: BookingStatus, to: BookingStatus) {
    super('INVALID_TRANSITION', `Cannot change booking status from ${from} to ${to}`);
  }
}

export class VersionConflictError extends BookingError {
  constructor() {
    super('VERSION_CONFLICT', 'Booking was changed by someone else');
  }
}

/** Срок hold истёк: подтвердить нельзя, запись будет переведена в expired (booking.hold.expired). */
export class HoldExpiredError extends BookingError {
  constructor() {
    super('HOLD_EXPIRED', 'The hold on this booking has expired');
  }
}
