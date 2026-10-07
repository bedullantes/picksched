export type Role = 'admin' | 'player';

export interface User {
  id: string;
  email: string;
  role: Role;
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
export type BookingStatus = 'pending' | 'confirmed' | 'cancelled';

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
    holdExpiresAt: string | null;
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
  holdExpiresAt: string | null;
  createdAt: string;
  isMine?: boolean;
  holdExpired?: boolean;
}

export interface MaintenanceBlock {
  id: string;
  courtId: string;
  startTime: string;
  endTime: string;
  reason: string | null;
}
