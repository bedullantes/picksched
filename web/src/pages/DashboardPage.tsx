import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { AppHeader } from '../components/AppHeader';
import { BarChart, type BarDatum } from '../dashboard/BarChart';
import type { DashboardData, PeriodSummary } from '../dashboard/types';
import { addDays, DEFAULT_TIMEZONE, formatDate, formatMoney, todayIn } from '../lib/format';

/* Chart colors: validated with the dataviz palette checks against the light surface. */
const REVENUE_COLOR = '#0d9488';
const OCCUPANCY_COLOR = '#2a78d6';

type Preset = '7d' | '30d' | 'month' | 'custom';

const TABLE_COLUMNS = ['Date', 'Bookings', 'Booked / open hours', 'Occupancy', 'Payments', 'Revenue', 'Net'] as const;

function presetRange(preset: Exclude<Preset, 'custom'>, today: string): { start: string; end: string } {
  if (preset === '7d') return { start: addDays(today, -6), end: today };
  if (preset === '30d') return { start: addDays(today, -29), end: today };
  return { start: `${today.slice(0, 8)}01`, end: today };
}

const pct = (rate: number | null) => (rate === null ? '—' : `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`);
const compactMoney = (centavos: number, currency: string) =>
  new Intl.NumberFormat('en-PH', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(centavos / 100);
const shortDate = (d: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`));

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {detail && <span className="stat-detail">{detail}</span>}
    </div>
  );
}

const occupancyDetail = (s: PeriodSummary) =>
  s.occupancy.availableHours > 0
    ? `${s.occupancy.bookedHours} of ${s.occupancy.availableHours} court-hours booked`
    : 'No bookable hours';

/**
 * Admin / Owner dashboard: bookings, occupancy and revenue for the signed-in
 * owner's courts. Data comes from GET /api/dashboard, which only covers the
 * owner's own courts.
 */
export function DashboardPage() {
  const initialToday = todayIn(DEFAULT_TIMEZONE);
  const [preset, setPreset] = useState<Preset>('30d');
  const [start, setStart] = useState(addDays(initialToday, -29));
  const [end, setEnd] = useState(initialToday);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const rangeError = end < start ? "End date can't be earlier than the start date." : null;
  const request = useRef(0);

  const load = useCallback(async () => {
    if (end < start) return;
    const id = ++request.current;
    setLoading(true);
    try {
      const res = await api<DashboardData>('/api/dashboard', { query: { start, end } });
      if (id === request.current) {
        setData(res);
        setFailed(false);
      }
    } catch {
      if (id === request.current) setFailed(true);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep figures current: refetch when bookings or payments change (debounced).
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void loadRef.current(), 1500);
    };
    es.addEventListener('schedule-changed', soon);
    es.addEventListener('resync', soon);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, []);

  const today = data?.today ?? initialToday;
  const choosePreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') {
      const r = presetRange(p, today);
      setStart(r.start);
      setEnd(r.end);
    }
  };

  const currency = data?.currency ?? 'PHP';
  const revenueBars: BarDatum[] = (data?.daily ?? []).map((d) => ({
    key: d.date,
    label: shortDate(d.date),
    title: formatDate(d.date),
    value: d.revenue,
    detail: `${d.payments} payment${d.payments === 1 ? '' : 's'} · ${formatMoney(d.netRevenue, currency)} net`,
  }));
  const occupancyBars: BarDatum[] = (data?.daily ?? []).map((d) => ({
    key: d.date,
    label: shortDate(d.date),
    title: formatDate(d.date),
    value: d.occupancyRate,
    detail: d.availableHours > 0 ? `${d.bookedHours} of ${d.availableHours} court-hours · ${d.bookings} bookings` : 'No bookable hours',
  }));
  const hasRevenue = !!data && data.range.revenue.payments > 0;
  const hasCapacity = !!data && data.range.occupancy.availableHours > 0;

  return (
    <>
      <AppHeader />
      <main className="page dashboard">
        <div className="page-heading">
          <h1>Dashboard</h1>
          <p className="page-subtitle">
            Bookings, occupancy and revenue for your courts{data ? ` · times in ${data.timezone}` : ''}.
          </p>
        </div>

        {failed && !data && (
          <div className="error-panel" role="alert">
            <h3>Unable to load analytics at this time.</h3>
            <p>Please check your connection and try again.</p>
            <button type="button" className="button-primary" onClick={() => void load()}>Try again</button>
          </div>
        )}

        {!data && loading && !failed && (
          <div className="dashboard-skeleton" aria-hidden="true">
            {Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton-block" />)}
            <p className="visually-hidden" role="status">Loading analytics…</p>
          </div>
        )}

        {data && data.courts.registered === 0 && (
          <div className="empty-state">
            <h3>No courts yet</h3>
            <p>Once you add courts and players start booking, your occupancy and revenue will appear here.</p>
          </div>
        )}

        {data && data.courts.registered > 0 && (
          <div className={`dashboard-body${loading ? ' is-refreshing' : ''}`} aria-busy={loading}>
            {failed && (
              <p className="banner banner--error" role="alert">
                Unable to load analytics at this time. Showing the last figures loaded.{' '}
                <button type="button" className="link-button" onClick={() => void load()}>Try again</button>
              </p>
            )}

            <section aria-labelledby="overview-heading">
              <h2 id="overview-heading" className="section-title">Today and the next 7 days</h2>
              <div className="stat-grid">
                <StatTile label="Bookings today" value={String(data.overview.today.bookings)}
                  detail={formatDate(data.today, 'short')} />
                <StatTile label="Occupancy today" value={pct(data.overview.today.occupancy.rate)}
                  detail={occupancyDetail(data.overview.today)} />
                <StatTile label="Bookings, next 7 days" value={String(data.overview.nextSevenDays.bookings)}
                  detail={`${shortDate(data.overview.nextSevenDays.start)} – ${shortDate(data.overview.nextSevenDays.end)}`} />
                <StatTile label="Occupancy, next 7 days" value={pct(data.overview.nextSevenDays.occupancy.rate)}
                  detail={occupancyDetail(data.overview.nextSevenDays)} />
              </div>
              <p className="hint">
                Confirmed (paid) bookings on your {data.courts.active} active court{data.courts.active === 1 ? '' : 's'}
                {data.courts.registered > data.courts.active ? ` (${data.courts.registered - data.courts.active} inactive not counted)` : ''}.
                Occupancy = booked hours ÷ open hours, excluding maintenance.
              </p>
            </section>

            <section aria-labelledby="range-heading" className="dashboard-range">
              <div className="range-header">
                <h2 id="range-heading" className="section-title">Revenue and occupancy</h2>
                <div className="filter-row" role="group" aria-label="Date range">
                  <div className="segmented">
                    {([['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['custom', 'Custom']] as const).map(([p, label]) => (
                      <button key={p} type="button" aria-pressed={preset === p} onClick={() => choosePreset(p)}>{label}</button>
                    ))}
                  </div>
                  <label className="field-inline">
                    <span>From</span>
                    <input type="date" value={start}
                      onChange={(e) => { setPreset('custom'); if (e.target.value) setStart(e.target.value); }} aria-invalid={!!rangeError} />
                  </label>
                  <label className="field-inline">
                    <span>To</span>
                    <input type="date" value={end}
                      onChange={(e) => { setPreset('custom'); if (e.target.value) setEnd(e.target.value); }} aria-invalid={!!rangeError} />
                  </label>
                </div>
              </div>
              {rangeError && <p className="field-error" role="alert">{rangeError}</p>}

              <div className="stat-grid stat-grid--range">
                <div className="stat-tile stat-tile--hero">
                  <span className="stat-label">Revenue</span>
                  <span className="stat-value">{formatMoney(data.range.revenue.gross, currency)}</span>
                  <span className="stat-detail">
                    {data.range.revenue.payments} paid booking{data.range.revenue.payments === 1 ? '' : 's'} ·{' '}
                    {formatDate(data.range.start, 'short')} – {formatDate(data.range.end, 'short')}
                  </span>
                </div>
                <StatTile label="Your net after fees" value={formatMoney(data.range.revenue.net, currency)}
                  detail={`PayMongo ${formatMoney(data.range.revenue.providerFees, currency)} · platform ${formatMoney(data.range.revenue.platformFees, currency)}`} />
                <StatTile label="Average occupancy" value={pct(data.range.occupancy.rate)} detail={occupancyDetail(data.range)} />
                <StatTile label="Bookings" value={String(data.range.bookings)} detail="Confirmed, by play date" />
              </div>

              <div className="chart-grid">
                <figure className="chart-card">
                  <figcaption>
                    <span className="chart-title">Daily revenue</span>
                    <span className="chart-subtitle">Paid bookings, by payment date</span>
                  </figcaption>
                  {hasRevenue ? (
                    <BarChart data={revenueBars} color={REVENUE_COLOR} ariaLabel="Daily revenue column chart"
                      formatValue={(v) => formatMoney(v, currency)} formatTick={(v) => compactMoney(v, currency)} />
                  ) : (
                    <p className="chart-empty">No payments in this period.</p>
                  )}
                </figure>
                <figure className="chart-card">
                  <figcaption>
                    <span className="chart-title">Daily occupancy</span>
                    <span className="chart-subtitle">Booked hours ÷ open hours</span>
                  </figcaption>
                  {hasCapacity ? (
                    <BarChart data={occupancyBars} color={OCCUPANCY_COLOR} max={1} ariaLabel="Daily occupancy column chart"
                      formatValue={(v) => pct(v)} formatTick={(v) => `${Math.round(v * 100)}%`} />
                  ) : (
                    <p className="chart-empty">No bookable hours in this period.</p>
                  )}
                </figure>
              </div>

              {(hasRevenue || hasCapacity) && (
                <div className="table-toggle">
                  <button type="button" className="link-button link-button--standalone" aria-expanded={showTable} onClick={() => setShowTable(!showTable)}>
                    {showTable ? 'Hide data table' : 'Show data table'}
                  </button>
                </div>
              )}
              {showTable && (
                <div className="table-wrap">
                  {/* Explicit roles keep table semantics when small screens restyle rows as cards. */}
                  <table className="data-table" role="table">
                    <caption className="visually-hidden">Daily bookings, occupancy and revenue</caption>
                    <thead role="rowgroup">
                      <tr role="row">
                        {TABLE_COLUMNS.map((c) => <th key={c} scope="col" role="columnheader">{c}</th>)}
                      </tr>
                    </thead>
                    <tbody role="rowgroup">
                      {data.daily.map((d) => (
                        <tr key={d.date} role="row">
                          <th scope="row" role="rowheader">{formatDate(d.date, 'short')}</th>
                          <td role="cell" data-label={TABLE_COLUMNS[1]}>{d.bookings}</td>
                          <td role="cell" data-label={TABLE_COLUMNS[2]}>{d.bookedHours} / {d.availableHours}</td>
                          <td role="cell" data-label={TABLE_COLUMNS[3]}>{pct(d.occupancyRate)}</td>
                          <td role="cell" data-label={TABLE_COLUMNS[4]}>{d.payments}</td>
                          <td role="cell" data-label={TABLE_COLUMNS[5]}>{formatMoney(d.revenue, currency)}</td>
                          <td role="cell" data-label={TABLE_COLUMNS[6]}>{formatMoney(d.netRevenue, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
        {data && <p className="hint dashboard-footer"><Link to="/bookings">Go to the facility schedule</Link></p>}
      </main>
    </>
  );
}
