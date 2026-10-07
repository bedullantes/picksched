# Booking notifications (SendGrid email, Twilio SMS)

When PayMongo confirms a payment, the player gets a **booking confirmation** and the court owner gets a **booking alert**, each by email and, if they've saved a mobile number, by SMS.

```
PayMongo webhook ─> apply_payment_result(): booking -> confirmed
                      └─ trigger: queue notifications (player + owner) × (email, + sms if phone)   [same DB transaction]
webhook responds 200 ─> dispatcher.kick()  (background, not awaited)
dispatcher ─> SendGrid POST /v3/mail/send          ─> notifications.status = sent (+ message id)
           ─> Twilio   POST /2010-04-01/.../Messages.json
Twilio ─ status callback ─> /api/webhooks/twilio/status ─> delivered | failed
```

## Guarantees

| Requirement | How |
|---|---|
| Sent on successful payment | Messages are queued by a database trigger when a booking becomes `confirmed`, which only a verified PayMongo payment can do. They're queued in the same transaction, so a confirmed booking always has its messages queued |
| Asynchronous | The webhook responds first. Sending runs in the background (`NotificationDispatcher.kick()`), plus a run every 5 seconds for retries |
| Within 2 minutes | First attempt is immediate (0.2 s in local tests). Retries come after 15 s, 30 s, 60 s, 120 s and 240 s, so the first four attempts all fall within 2 minutes |
| Only for confirmed bookings | Booking details and status are read fresh at send time. If the booking is no longer `confirmed`, the confirmation and alert are `skipped`. Unpaid, failed or expired payments never queue anything |
| Content | Court name (and location), date, time, amount and booking reference (`PS-XXXXXXXX`, the first 8 characters of the booking id). The email also includes the full booking id. Times use the court's time zone |
| Failures don't affect payment | Delivery happens outside the payment transaction and after the webhook response. Errors are caught, stored on the notification (`last_error`) and logged as `[notifications] … failed (attempt n, will retry / giving up)` |
| Audit | `bookings.confirmed_at`, `confirmation_email_sent_at`, `confirmation_sms_sent_at`. In `notifications`, per channel: `status`, `attempts`, `provider`, `provider_message_id`, `recipient_address`, `sent_at`, `delivered_at`, `failed_at`, `last_error` |

### Deliverability (SMS)

- **Messaging Service** (`TWILIO_MESSAGING_SERVICE_SID`) is preferred over a single from-number. Twilio then picks the right sender per carrier and handles fallback.
- **One plain segment.** SMS text is reduced to ASCII and kept to 160 characters or fewer, shortening the court name if needed. A single character like `₱` or `–` would switch the whole message to Unicode, which allows only 70 characters per segment and so costs and fails more often. Amounts are written `PHP 400.00`.
- **Mobile numbers only.** Numbers are normalized to E.164 (`0917 123 4567` becomes `+639171234567`). Philippine landlines are rejected at entry, since they can't receive SMS.
- **Retries:**
  - 429/5xx responses and network errors are retried.
  - 4xx rejections are permanent and aren't retried, for example an invalid or unsubscribed number (Twilio 21211 / 21610).
- **Delivery receipts:** set `TWILIO_STATUS_CALLBACK_URL` and Twilio reports `delivered` or `undelivered` for each SMS. Receipts are verified with `X-Twilio-Signature`, and undelivered SMS are logged.

Email is sent as a transactional message with text and HTML parts, with click tracking off. Court names are HTML-escaped. Set up SendGrid **domain authentication** (SPF/DKIM) for the from-address domain, or Gmail and Yahoo may reject or spam-folder the mail.

## Configuration

| Variable | |
|---|---|
| `SENDGRID_API_KEY` | Enables SendGrid email (Mail Send permission is enough) |
| `SENDGRID_FROM_EMAIL` | Verified sender, e.g. `bookings@yourdomain.ph` (required with a key) |
| `SENDGRID_FROM_NAME` | Default `PickSched` |
| `SENDGRID_SANDBOX_MODE` | `true`: SendGrid validates but delivers nothing (staging) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Enable Twilio SMS |
| `TWILIO_MESSAGING_SERVICE_SID` | Recommended sender, or set `TWILIO_FROM_NUMBER` (E.164) |
| `TWILIO_STATUS_CALLBACK_URL` | Public URL of `/api/webhooks/twilio/status`, for delivery receipts (optional) |
| `EMAIL_PROVIDER` / `SMS_PROVIDER` | Override: `sendgrid` / `twilio`, `log`, `webhook`, and for SMS also `off`. Default: the provider whose key is set, otherwise `NOTIFICATIONS_TRANSPORT` |
| `SENDGRID_API_BASE`, `TWILIO_API_BASE` | Service endpoints (defaults `https://api.sendgrid.com`, `https://api.twilio.com`) |
| `NOTIFICATIONS_TIMEOUT_MS` | Provider request timeout, default 10000 |
| `NOTIFICATIONS_INTERVAL_MS` | Retry loop interval, default 5000 |
| `PHONE_DEFAULT_COUNTRY_CODE` | For local numbers, default `63` |

With no providers configured, messages go to the server log (`NOTIFICATIONS_TRANSPORT=log`) or to `NOTIFICATIONS_WEBHOOK_URL`, as before.

**Local development:** `npm run dev:messaging -w api` runs SendGrid and Twilio stand-ins on port 4020. Point `SENDGRID_API_BASE` and `TWILIO_API_BASE` at it and see what was sent at `http://localhost:4020/_sent`. The tests use the same stand-ins. **Send one real message through each provider** before going live.

## Phone numbers

- **Players:** add a mobile number at sign-up, or later on the **Account** page (`PATCH /api/auth/me { phone }`). An empty value removes it, and the user then gets email only.
- **Reminder:** players without a number see a prompt at checkout to add one.
- **Number changes:** SMS goes to the number saved when the booking was confirmed.

## API

| Endpoint | |
|---|---|
| `PATCH /api/auth/me` `{ phone }` | Set or clear the user's mobile number (400 `INVALID_PHONE` with a helpful message) |
| `GET /api/auth/me` | Includes `phone` |
| `GET /api/notifications` | The user's notifications (all channels) |
| `POST /api/webhooks/twilio/status` | Twilio delivery receipts (signature-checked) |

## Not included

- Reminder messages before the booking (e.g. 2 hours ahead), which would further reduce no-shows. The outbox and providers make this a small addition.
- SendGrid event webhook (bounces, spam reports).
- Per-user opt-out preferences beyond removing the phone number.
