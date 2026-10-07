# Owner dashboard

`/dashboard` shows court owners their bookings, occupancy and revenue. Owners reach it from the **Dashboard** link in the header.

## Access

| Who | Result |
|---|---|
| Signed out | Redirected to sign in, then back to the dashboard |
| Player | Redirected to `/unauthorized` ("You don't have access to this page"); the API returns 403 |
| Court owner (`admin`) | Sees only their own courts' data |

Ownership is enforced in three places:

1. The page route only renders for owners.
2. `GET /api/dashboard` requires the owner role.
3. The database function `owner_daily_metrics()` filters to courts where `owner_id` is the signed-in user, refuses anyone who isn't an owner, and runs under row-level security.

## What's shown

**Today and the next 7 days** (always shown, independent of the filter):

| Tile | Definition |
|---|---|
| Bookings today | Confirmed bookings starting today |
| Occupancy today | Booked hours ÷ open hours today, as a percentage |
| Bookings, next 7 days | Confirmed bookings from today through the 6th day after |
| Occupancy, next 7 days | Same ratio over those 7 days |

**Revenue and occupancy for a date range.** Presets are Last 7 days, Last 30 days (default) and This month; Custom accepts any range up to a year.

| Tile / chart | Definition |
|---|---|
| Revenue | Sum of `transactions.amount` with status **`paid`**, by the date the payment was processed |
| Your net after fees | Revenue − PayMongo fees − platform commission (`transactions.owner_net`) |
| Average occupancy | Booked hours ÷ open hours over the range |
| Bookings | Confirmed bookings played in the range |
| Daily revenue | One column per day |
| Daily occupancy | One column per day, 0–100% |

Hover or focus a chart and use the arrow keys to read each day. **Show data table** lists every day's figures.

### Definitions

| Term | Meaning |
|---|---|
| Booked hours | Confirmed (paid) bookings only. Unpaid holds (`pending_payment`) and cancelled bookings don't count |
| Open hours | For each of the owner's **active** courts: opening to closing time each day, minus maintenance blocks. Inactive courts can't be booked, so they're excluded and the page says how many there are. Days before a court was added don't count |
| Revenue | Only `paid` transactions. Pending, processing, failed and refunded payments are excluded |
| Dates | Calendar days in the facility's time zone (the time zone most of the owner's courts use) |

The dashboard refreshes itself when bookings or payments change, using the same live-update stream as the calendar.

### States

| Situation | What's shown |
|---|---|
| Loading | Placeholder tiles. A refresh fades the current figures instead of blanking them |
| No courts yet | An empty state explaining that data will appear once courts are booked |
| No payments in the range | The revenue chart shows "No payments in this period." |
| No open hours in the range | The occupancy chart shows "No bookable hours in this period." |
| End date before start date | Inline error, and nothing is fetched. The API also returns `400 INVALID_RANGE` |
| Range over a year | `400 RANGE_TOO_LONG` |
| Fetch fails | "Unable to load analytics at this time." with **Try again**. If figures were already shown, they stay with a banner |

## API

`GET /api/dashboard?start=YYYY-MM-DD&end=YYYY-MM-DD` (owners only; defaults to the last 30 days)

```json
{
  "timezone": "Asia/Manila", "currency": "PHP", "today": "2026-10-07",
  "courts": { "registered": 3, "active": 2 },
  "overview": {
    "today":         { "bookings": 2, "occupancy": { "bookedHours": 3, "availableHours": 32, "rate": 0.09375 }, "revenue": { … } },
    "nextSevenDays": { "start": "2026-10-07", "end": "2026-10-13", "bookings": 4, "occupancy": { … }, "revenue": { … } }
  },
  "range": { "start": "…", "end": "…", "bookings": 30,
             "occupancy": { "bookedHours": 48, "availableHours": 960, "rate": 0.05 },
             "revenue": { "payments": 28, "gross": 1250000, "providerFees": 31250, "platformFees": 62500, "net": 1156250 } },
  "daily": [ { "date": "…", "activeCourts": 2, "bookings": 1, "bookedHours": 2, "availableHours": 32,
               "occupancyRate": 0.0625, "payments": 1, "revenue": 100000, "netRevenue": 92500 } ]
}
```

Amounts are in centavos. `rate` is a fraction (0–1), or `null` when there were no open hours.
