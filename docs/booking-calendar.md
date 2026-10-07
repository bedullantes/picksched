# Booking Calendar Module

An interactive calendar where players see live court availability and book open slots, and court owners manage their facility schedule.

```
web/ (React)                      api/ (Express)                     PostgreSQL
BookingCalendar ── GET /api/availability ──> get_availability() ──> bookings, court_blocks
   │  click open slot                                                 (RLS per user)
   ├─ BookingModal ── POST /api/bookings ──> INSERT bookings ──> no-overlap constraints
   │                                                                   │
   └─ EventSource ── GET /api/events (SSE) <── LISTEN picksched_schedule <── NOTIFY on change
```

## What each role sees

| | Player | Court owner (admin) |
|---|---|---|
| Courts shown | All active courts | Their own courts (including inactive ones) |
| Open slot | **Available** + price. Click to book | **Open**. Click to block for maintenance |
| Someone else's booking | **Booked**, with no details | Player email + *Pending payment* / *Confirmed*. Click to confirm, cancel or reschedule |
| Own booking | **Your booking**. Click to cancel or continue to payment | n/a |
| Maintenance | **Maintenance** (unavailable) | **Maintenance** + reason. Click to remove the block |
| Past / within 1 hour | **Unavailable** | **Too soon to book**. Can still be blocked if it hasn't ended |

Pending (unpaid) bookings have a dashed outline. The database decides who sees what (`get_availability`), so the API can't leak details by mistake.

## Views and layout

- **Day**: one column per court, one row per time slot.
- **Week**: 7 days for one court (court picker in the toolbar).
- **Navigation**: previous/next, Today, and a date picker. Dates before today are disabled in the picker, rejected if typed, and the previous button stops at today.
- **Small screens** (≤ 720px): columns stack into cards and slots wrap as chips that show their own time. Modals become bottom sheets.
- **Loading**: a shimmer skeleton on first load, and an "Updating…" indicator on refreshes.
- Times are shown in the court's time zone, not the browser's.

## Booking flow

1. The player clicks an **Available** slot. The **Confirm booking** modal opens with the court, date, time and price filled in. The player can extend the duration over consecutive open slots, up to 4 hours.
2. **Reserve & continue** calls `POST /api/bookings`. The API re-checks the slot against the live schedule (advance rule, opening hours and slot alignment, maintenance, other bookings) and inserts a `pending` booking. That holds the slot for 15 minutes.
3. The player goes to **Checkout** (`/bookings/:id/checkout`), which shows a hold countdown.
4. **Proceed to payment** calls `POST /api/bookings/:id/checkout`, which checks on the server that the hold is still valid before payment. PayMongo checkout plugs in at this step (payments module). Until then, owners can mark a booking as paid.

## Concurrency: no double bookings

- The database is the final authority. An exclusion constraint rejects overlapping active bookings, and a per-court lock stops a booking and a maintenance block from colliding. Of N simultaneous requests for one slot, exactly one succeeds. The API tests check this with 8 parallel requests, and with a booking racing a block.
- The loser gets **409**: *"This time slot is no longer available. Someone else may have just booked it."* The calendar refreshes immediately.
- **Live updates:** every change sends a database `NOTIFY`, and the API pushes it over Server-Sent Events. Calendars viewing that court and time range refetch within about 250 ms. If a player has the confirmation modal open and the slot is taken, the modal says so and disables the button before they click.
- **Fallbacks:**
  - If the live connection drops, the toolbar shows *Reconnecting…*, a banner explains, and the calendar polls every 20 seconds.
  - On reconnect it refetches, in case it missed changes.
  - It also refetches when the tab becomes visible again.

## Connectivity and error handling

| Situation | What the user sees |
|---|---|
| Browser goes offline | Warning banner. Booking and blocking are disabled. Refetches automatically when back online |
| Request can't reach the server | "Can't reach PickSched. Check your internet connection and try again." |
| Request takes over 15 s | "The server took too long to respond. Please try again." |
| Database statement timeout (5 s) | 503: "The booking service is busy right now. Please try again in a moment." |
| Database unreachable | 503: "The booking service is temporarily unavailable. Please try again shortly." |
| Load fails with no data yet | Error panel with **Try again** |
| Refresh fails with data on screen | Banner, with the last known schedule kept on screen |
| Slot just taken | 409 message in the modal, and the calendar refreshes |
| Hold expired before checkout | 409 `HOLD_EXPIRED`, with a link back to the calendar |

If the database drops its connections, the API stays up: the pool replaces broken connections, and the change listener reconnects and tells browsers to resync.

## API reference

All endpoints are under `/api`. Errors look like `{ "error": { "code", "message" } }`, and `message` is safe to show to users.

| Method & path | Who | Purpose |
|---|---|---|
| `POST /auth/register` `{email, password, role}` | Anyone | Create an account and start a session (httpOnly cookie) |
| `POST /auth/login` `{email, password}` | Anyone | Sign in |
| `POST /auth/logout` | Anyone | Sign out |
| `GET /auth/me` | Signed in | Current user |
| `GET /courts[?mine=1]` | Anyone | Visible courts (`mine=1`: the owner's own courts) |
| `GET /availability?start=YYYY-MM-DD&days=1..14[&courtId][&mine=1]` | Anyone | Slots with status (see `get_availability`) |
| `POST /bookings` `{courtId, startTime, endTime}` | Signed in | Hold a slot (pending) |
| `GET /bookings/:id` | Player or owner | Booking details |
| `POST /bookings/:id/checkout` | The booking's player | Final hold check before payment |
| `POST /bookings/:id/cancel` | Player or owner | Cancel |
| `POST /bookings/:id/confirm` | Owner | Mark as paid / confirmed |
| `PATCH /bookings/:id` `{courtId?, startTime, endTime}` | Owner | Reschedule |
| `GET /maintenance-blocks[?courtId&from&to]` | Owner | List blocks |
| `POST /maintenance-blocks` `{courtId, startTime, endTime, reason?}` | Owner | Block time |
| `DELETE /maintenance-blocks/:id` | Owner | Remove a block |
| `GET /events` | Signed in | SSE stream: `schedule-changed`, `resync` |

Booking error codes:

| Code | HTTP | Meaning |
|---|---|---|
| `SLOT_UNAVAILABLE` | 409 | The slot is already taken |
| `COURT_UNDER_MAINTENANCE` | 409 | The court is blocked for maintenance at that time |
| `TOO_SOON` | 422 | Less than 1 hour in advance |
| `SLOT_IN_PAST` | 422 | The time has already passed |
| `INVALID_SLOT` | 422 | The time doesn't match the court's slots or opening hours |
| `TOO_LONG` | 422 | More than 4 hours |
| `COURT_INACTIVE` | 422 | The court isn't accepting bookings |
| `HOLD_EXPIRED` | 409 | The hold lapsed before checkout |
| `BOOKING_CANCELLED` | 409 | The booking was cancelled |

## Security notes

- Every database call runs as `picksched_app` with the user's id set, so row-level security applies even if the API connects as a privileged role.
- Sessions are HMAC-signed, httpOnly, `SameSite=Lax` cookies. Set `COOKIE_SECURE=true` (the default when `NODE_ENV=production`) behind HTTPS.
- Passwords are hashed with bcrypt. Login takes the same time whether or not the email exists.
- Not yet included: login rate limiting and password reset.
