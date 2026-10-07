import type { Deps } from './context.js';
import { withUser } from './db.js';

/*
 * Notification delivery. The database queues messages in the notifications
 * table (booking confirmed, payment refunded, ...). This dispatcher sends them
 * through a transport:
 *   log      prints to the server log (default; development)
 *   webhook  POSTs each message as JSON to NOTIFICATIONS_WEBHOOK_URL, e.g. an
 *            email/SMS service or automation tool (Zapier, Make, n8n)
 */

export interface NotificationMessage {
  id: string;
  kind: string;
  to: string;
  recipientRole: string;
  subject: string;
  text: string;
  data: Record<string, unknown>;
}

export interface NotificationTransport {
  send(message: NotificationMessage): Promise<void>;
}

export const logTransport: NotificationTransport = {
  async send(m) {
    console.log(`[notification] to=${m.to} kind=${m.kind} subject="${m.subject}"`);
  },
};

export function webhookTransport(url: string, timeoutMs = 10_000): NotificationTransport {
  return {
    async send(m) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`notification webhook returned ${res.status}`);
    },
  };
}

function money(centavos: number, currency: string) {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(centavos / 100);
}

function when(d: Record<string, any>) {
  const tz = d.timezone ?? 'Asia/Manila';
  const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' })
    .format(new Date(d.start_time));
  const t = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
    .format(new Date(iso));
  return `${date}, ${t(d.start_time)} – ${t(d.end_time)}`;
}

export function renderNotification(kind: string, d: Record<string, any>): { subject: string; text: string } {
  const slot = `${d.court_name}, ${when(d)}`;
  switch (kind) {
    case 'booking_confirmed':
      return {
        subject: `Booking confirmed: ${d.court_name}`,
        text: `Your payment of ${money(d.total_amount, d.currency)} was received and your booking is confirmed.\n\n${slot}\n\nSee you on the court!`,
      };
    case 'booking_received':
      return {
        subject: `New paid booking: ${d.court_name}`,
        text: `A player booked and paid for ${slot} (${money(d.total_amount, d.currency)}).`,
      };
    case 'payment_refunded':
      return {
        subject: `Refund issued: ${d.court_name}`,
        text: `Your payment for ${slot} arrived after the booking hold expired, so the slot was released and we refunded ${money(d.total_amount, d.currency)}. Refunds can take several business days to appear.`,
      };
    default:
      return { subject: `PickSched update`, text: JSON.stringify(d) };
  }
}

/** Sends one batch of queued notifications. Returns how many were sent. */
export async function dispatchNotifications(deps: Pick<Deps, 'db' | 'config'>, transport: NotificationTransport): Promise<number> {
  const run = <T>(fn: (tx: import('./db.js').Tx) => Promise<T>) =>
    withUser(deps.db, null, deps.config.dbStatementTimeoutMs, fn);
  const batch = await run(async (tx) => (await tx.query('SELECT * FROM claim_notifications(20)')).rows);
  let sent = 0;
  for (const n of batch) {
    const { subject, text } = renderNotification(n.kind, n.payload);
    let error: string | null = null;
    try {
      await transport.send({ id: n.id, kind: n.kind, to: n.recipient_email, recipientRole: n.recipient_role, subject, text, data: n.payload });
      sent++;
    } catch (err) {
      error = (err as Error).message;
      console.error(`Notification ${n.id} failed (attempt ${n.attempts}):`, error);
    }
    await run((tx) => tx.query('SELECT mark_notification_result($1, $2)', [n.id, error]));
  }
  return sent;
}

export function transportFor(config: Deps['config']): NotificationTransport {
  return config.notifications.transport === 'webhook' ? webhookTransport(config.notifications.webhookUrl!) : logTransport;
}
