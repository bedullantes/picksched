export type Role = 'admin' | 'player';

export interface User {
  id: string;
  email: string;
  role: Role;
  /** E.164 mobile number for SMS confirmations, if given. */
  phone?: string | null;
}

export interface Court {
  id: string;
  name: string;
  description: string | null;
  location: string | null;
  hourlyRate: number; // centavos
  currency: string;
  isActive: boolean;
  timezone: string;
  opensAt: string; // HH:MM
  closesAt: string;
  slotMinutes: number;
  isOwner: boolean;
}

export type SlotStatus = 'available' | 'booked' | 'mine' | 'maintenance' | 'unavailable';
export type BookingStatus = 'pending_payment' | 'confirmed' | 'cancelled';

export interface Slot {
  courtId: string;
  date: string; // YYYY-MM-DD, court-local
  startTime: string; // ISO
  endTime: string;
  status: SlotStatus;
  booking?: {
    id: string;
    status: BookingStatus;
    startTime: string;
    endTime: string;
    /** When an unpaid booking releases the slot. */
    expiresAt: string | null;
    playerEmail?: string;
  };
  block?: { id: string; reason: string | null };
}

export interface Availability {
  serverTime: string;
  rules: { minLeadMinutes: number; holdMinutes: number };
  start: string;
  days: number;
  courts: Court[];
  slots: Slot[];
}

export interface Booking {
  id: string;
  courtId: string;
  courtName?: string;
  courtTimezone?: string;
  playerId: string;
  startTime: string;
  endTime: string;
  status: BookingStatus;
  totalAmount: number;
  currency: string;
  /** When an unpaid booking releases the slot. */
  expiresAt: string | null;
  createdAt: string;
  isMine?: boolean;
  holdExpired?: boolean;
  paymentStatus?: PaymentStatus;
  payment?: BookingPayment | null;
}

export type PaymentStatus = 'unpaid' | 'processing' | 'paid' | 'failed' | 'expired' | 'refunded';
export type PaymentMethod = 'gcash' | 'paymaya';

export interface BookingPayment {
  status: 'pending' | 'processing' | 'paid' | 'failed' | 'refunded';
  method: PaymentMethod | null;
  amount: number;
  failureCode: string | null;
  failureMessage: string | null;
  processedAt: string | null;
  refunded: boolean;
}

/** Response of POST /api/bookings/:id/checkout. */
export interface CheckoutResult {
  state: 'awaiting_payment' | 'confirmed';
  booking: Booking;
  payment: {
    provider: 'paymongo';
    amount: number;
    currency: string;
    methods?: PaymentMethod[];
    checkoutUrl?: string;
    expiresAt?: string;
  };
}

/** Response of POST /api/bookings: the hold plus what the payment step needs. */
export interface Reservation {
  booking: Booking;
  payment: { provider: 'paymongo'; amount: number; currency: string; expiresAt: string };
  next: 'payment';
  /** True when this was a retry of a request that had already succeeded. */
  replayed: boolean;
}

export interface MaintenanceBlock {
  id: string;
  courtId: string;
  startTime: string;
  endTime: string;
  reason: string | null;
}
