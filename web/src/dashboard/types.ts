export interface PeriodSummary {
  bookings: number;
  occupancy: { bookedHours: number; availableHours: number; rate: number | null };
  revenue: { payments: number; gross: number; providerFees: number; platformFees: number; net: number };
}

export interface DashboardDay {
  date: string;
  activeCourts: number;
  bookings: number;
  bookedHours: number;
  availableHours: number;
  occupancyRate: number | null;
  payments: number;
  revenue: number;
  netRevenue: number;
}

export interface DashboardData {
  timezone: string;
  currency: string;
  today: string;
  courts: { registered: number; active: number };
  overview: { today: PeriodSummary; nextSevenDays: PeriodSummary & { start: string; end: string } };
  range: PeriodSummary & { start: string; end: string };
  daily: DashboardDay[];
}
