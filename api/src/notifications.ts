import type { Config } from './config.js';
import type { Deps } from './context.js';
import { withUser, type Tx } from './db.js';
import { DeliveryError } from './messaging/errors.js';
import { maskEmail, maskPhone } from './messaging/phone.js';
import { SendGridClient } from './messaging/sendgrid.js';
import { bookingReference, renderMessage, type BookingDetails } from './messaging/templates.js';
import { TwilioClient } from './messaging/twilio.js';

/*
 * Notification delivery.
 *
 * When PayMongo's webhook confirms a booking, the database queues a
 * notification per recipient per channel (migration 006): the player's
 * confirmation and the owner's booking alert, by email and, if the recipient
 * has a phone number, by SMS. The dispatcher sends them through SendGrid and
 * Twilio. It runs outside the payment's database transaction and HTTP
 * response, so a notification failure can never affect the payment or the
 * booking. It's triggered right after the webhook (kick) and every few
 * seconds for retries.
 */

export type Channel = 'email' | 'sms';

export interface NotificationMessage {
  id: string;
  kind: string;
  channel: Channel;
  to: string;
  recipientRole: string;
  subject: string;
  text: string;
  html?: string;
  data: Record<string, unknown>;
}

/** Delivers messages for one channel. Throw DeliveryError(permanent) for errors not worth retrying. */
export interface ChannelTransport {
  provider: string;
  send(message: NotificationMessage): Promise<{ messageId?: string } | void>;
}

export interface Transports {
  email: ChannelTransport;
  /** null: SMS disabled. */
  sms: ChannelTransport | null;
}

/** A single transport for every channel (used by tests and the generic webhook). */
export type NotificationTransport = { send(message: NotificationMessage): Promise<unknown> };

const CONFIRMATION_KINDS = new Set(['booking_confirmed', 'booking_received']);

export const logTransport: ChannelTransport = {
  provider: 'log',
  async send(m) {
    console.log(`[notification] ${m.channel} to=${m.channel === 'sms' ? maskPhone(m.to) : maskEmail(m.to)} kind=${m.kind} subject="${m.subject}"`);
  },
};

export function webhookTransport(url: string, timeoutMs = 10_000): ChannelTransport {
  return {
    provider: 'webhook',
    async send(m) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(m),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new DeliveryError(`notification webhook failed: ${(err as Error).message}`, false);
      }
      if (!res.ok) throw new DeliveryError(`notification webhook returned ${res.status}`, res.status < 500 && res.status !== 429);
    },
  };
}

export function sendGridTransport(client: SendGridClient): ChannelTransport {
  return {
    provider: 'sendgrid',
    send: (m) => client.send({
      to: m.to, subject: m.subject, text: m.text, html: m.html ?? `<pre>${m.text}</pre>`,
      category: m.kind, customArgs: { notification_id: m.id },
    }),
  };
}

export function twilioTransport(client: TwilioClient): ChannelTransport {
  return { provider: 'twilio', send: (m) => client.sendSms(m.to, m.text) };
}

/** Builds the transports configured in the environment (see docs/notifications.md). */
export function transportsFor(config: Config): Transports {
  const n = config.notifications;
  const generic = n.transport === 'webhook' ? webhookTransport(n.webhookUrl!) : logTransport;
  // 'default' (no provider configured) falls back to NOTIFICATIONS_TRANSPORT.
  const email = n.email.provider === 'sendgrid' ? sendGridTransport(new SendGridClient(n.email.sendgrid!))
    : n.email.provider === 'webhook' ? webhookTransport(n.webhookUrl!)
    : n.email.provider === 'log' ? logTransport : generic;
  const sms = n.sms.provider === 'off' ? null
    : n.sms.provider === 'twilio' ? twilioTransport(new TwilioClient(n.sms.twilio!))
    : n.sms.provider === 'webhook' ? webhookTransport(n.webhookUrl!)
    : n.sms.provider === 'log' ? logTransport : generic;
  return { email, sms };
}

/** @deprecated single-transport form, kept for existing callers. */
export function transportFor(config: Config): NotificationTransport {
  return config.notifications.transport === 'webhook' ? webhookTransport(config.notifications.webhookUrl!) : logTransport;
}

function asTransports(t: Transports | NotificationTransport): Transports {
  if ('email' in t) return t;
  const single: ChannelTransport = { provider: 'custom', send: async (m) => { await t.send(m); } };
  return { email: single, sms: single };
}

function detailsFromRow(r: Record<string, any>): BookingDetails {
  return {
    bookingId: r.booking_id,
    courtName: r.court_name,
    courtLocation: r.court_location,
    timezone: r.timezone ?? 'Asia/Manila',
    startTime: new Date(r.start_time).toISOString(),
    endTime: new Date(r.end_time).toISOString(),
    totalAmount: Number(r.total_amount),
    currency: r.currency,
  };
}

/** Subject and text for a stored notification (in-app inbox). */
export function renderNotification(kind: string, payload: Record<string, any>): { subject: string; text: string } {
  const m = renderMessage(kind, detailsFromRow({ ...payload, booking_id: payload.id }));
  return { subject: m.subject, text: m.text };
}

export interface DispatchResult {
  sent: number;
  failed: number;
  skipped: number;
}

/** Sends one batch of due notifications. */
export async function dispatchNotifications(
  deps: Pick<Deps, 'db' | 'config'>,
  transportOrTransports: Transports | NotificationTransport,
): Promise<number> {
  return (await dispatchBatch(deps, asTransports(transportOrTransports))).sent;
}

export async function dispatchBatch(deps: Pick<Deps, 'db' | 'config'>, transports: Transports): Promise<DispatchResult> {
  const run = <T>(fn: (tx: Tx) => Promise<T>) => withUser(deps.db, null, deps.config.dbStatementTimeoutMs, fn);
  const batch = await run(async (tx) => (await tx.query('SELECT * FROM claim_notifications(25)')).rows);
  const result: DispatchResult = { sent: 0, failed: 0, skipped: 0 };

  await Promise.all(batch.map(async (n) => {
    const skip = async (reason: string) => {
      result.skipped++;
      await run((tx) => tx.query('SELECT mark_notification_skipped($1, $2)', [n.id, reason]));
    };
    // Confirmation and booking alerts only go out for bookings that are (still) confirmed.
    if (CONFIRMATION_KINDS.has(n.kind) && n.booking_status !== 'confirmed') {
      return skip(`booking is ${n.booking_status ?? 'missing'}`);
    }
    if (!n.booking_id || !n.court_name) return skip('booking is missing');
    const transport = n.channel === 'sms' ? transports.sms : transports.email;
    if (!transport) return skip('SMS is disabled');
    const to: string | null = n.channel === 'sms' ? n.recipient_phone : n.recipient_email;
    if (!to) return skip(n.channel === 'sms' ? 'no phone number' : 'no email address');

    const details = detailsFromRow(n);
    const content = renderMessage(n.kind, details);
    const message: NotificationMessage = {
      id: n.id,
      kind: n.kind,
      channel: n.channel,
      to,
      recipientRole: n.recipient_role,
      subject: content.subject,
      text: n.channel === 'sms' ? content.sms : content.text,
      html: n.channel === 'email' ? content.html : undefined,
      data: { ...details, id: details.bookingId, reference: bookingReference(details.bookingId) },
    };

    try {
      const sent = await transport.send(message);
      await run((tx) => tx.query('SELECT mark_notification_sent($1, $2, $3, $4)',
        [n.id, transport.provider, sent?.messageId ?? null, to]));
      result.sent++;
    } catch (err) {
      const permanent = err instanceof DeliveryError && err.permanent;
      const status = await run(async (tx) => (await tx.query('SELECT mark_notification_failed($1, $2, $3) AS s',
        [n.id, (err as Error).message.slice(0, 500), permanent])).rows[0].s);
      result.failed++;
      // Logged for monitoring; never surfaced to the payment flow.
      console.error(`[notifications] ${n.channel} ${n.kind} for booking ${n.booking_id} to `
        + `${n.channel === 'sms' ? maskPhone(to) : maskEmail(to)} failed (attempt ${n.attempts}, `
        + `${status === 'failed' ? 'giving up' : 'will retry'}): ${(err as Error).message}`);
    }
  }));
  return result;
}

/**
 * Runs dispatches on an interval (for retries) and on demand via kick()
 * (right after a payment is confirmed). Runs never overlap; a kick during
 * a run triggers one more run afterwards.
 */
export class NotificationDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly deps: Pick<Deps, 'db' | 'config'>,
    private readonly transports: Transports,
    private readonly intervalMs: number,
  ) {}

  start(): this {
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref();
    this.kick();
    return this;
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Dispatches now, without waiting. Never throws. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          const r = await dispatchBatch(this.deps, this.transports);
          if (r.sent + r.failed + r.skipped === 25) this.again = true; // full batch: there may be more
        } catch (err) {
          console.error('[notifications] dispatch failed:', (err as Error).message);
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
  }

  /** Resolves when no dispatch is running (for tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }
}
