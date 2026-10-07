/*
 * Notification content. Every message carries the court, date, time and
 * booking reference, formatted in the court's time zone.
 */

export interface BookingDetails {
  bookingId: string;
  courtName: string;
  courtLocation?: string | null;
  timezone: string;
  startTime: string; // ISO
  endTime: string;
  totalAmount: number; // centavos
  currency: string;
}

export interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
  sms: string;
}

/** Short reference shown to people: "PS-" + the first 8 characters of the booking id. */
export function bookingReference(bookingId: string): string {
  return `PS-${bookingId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

const fmt = (iso: string, tz: string, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(new Date(iso));

export function formatParts(d: BookingDetails) {
  const date = fmt(d.startTime, d.timezone, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const shortDate = fmt(d.startTime, d.timezone, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = `${fmt(d.startTime, d.timezone, { hour: 'numeric', minute: '2-digit' })} – ${fmt(d.endTime, d.timezone, { hour: 'numeric', minute: '2-digit' })}`;
  const amount = new Intl.NumberFormat('en-PH', { style: 'currency', currency: d.currency }).format(d.totalAmount / 100);
  // SMS: ASCII only, so the message stays in the GSM-7 alphabet (160 chars per segment).
  const smsTime = `${fmt(d.startTime, d.timezone, { hour: 'numeric', minute: '2-digit' })}-${fmt(d.endTime, d.timezone, { hour: 'numeric', minute: '2-digit' })}`;
  const smsAmount = `${d.currency} ${(d.totalAmount / 100).toFixed(2)}`;
  return { date, shortDate, time, amount, smsTime, smsAmount, reference: bookingReference(d.bookingId) };
}

/** Reduces text to plain ASCII: accents removed, anything else replaced. */
export function toAscii(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '?');
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Builds an SMS within one 160-character segment, shortening the court name if needed. */
function fitSms(build: (court: string) => string, courtName: string): string {
  let court = toAscii(courtName).trim();
  let sms = build(court);
  while (sms.length > 160 && court.length > 8) {
    court = `${court.slice(0, court.length - 2).trimEnd()}.`;
    sms = build(court);
  }
  return sms.slice(0, 160);
}

function emailHtml(heading: string, intro: string, d: BookingDetails, p: ReturnType<typeof formatParts>, footer: string) {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#64748b">${label}</td><td style="padding:6px 0;font-weight:600">${escapeHtml(value)}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td style="font-size:20px;font-weight:800;color:#0f766e;padding-bottom:12px">PickSched</td></tr>
<tr><td style="font-size:22px;font-weight:700;padding-bottom:8px">${escapeHtml(heading)}</td></tr>
<tr><td style="color:#334155;padding-bottom:16px">${escapeHtml(intro)}</td></tr>
<tr><td><table role="presentation" cellpadding="0" cellspacing="0">
${row('Court', d.courtName)}${d.courtLocation ? row('Location', d.courtLocation) : ''}${row('Date', p.date)}${row('Time', p.time)}${row('Amount', p.amount)}${row('Booking reference', p.reference)}
</table></td></tr>
<tr><td style="color:#64748b;font-size:13px;padding-top:18px">${escapeHtml(footer)}<br>Booking ID: ${escapeHtml(d.bookingId)}</td></tr>
</table></td></tr></table></body></html>`;
}

function textBody(intro: string, d: BookingDetails, p: ReturnType<typeof formatParts>, footer: string) {
  return [
    intro, '',
    `Court: ${d.courtName}`,
    ...(d.courtLocation ? [`Location: ${d.courtLocation}`] : []),
    `Date: ${p.date}`,
    `Time: ${p.time}`,
    `Amount: ${p.amount}`,
    `Booking reference: ${p.reference}`,
    '', footer, `Booking ID: ${d.bookingId}`,
  ].join('\n');
}

export function renderMessage(kind: string, d: BookingDetails): RenderedMessage {
  const p = formatParts(d);
  switch (kind) {
    case 'booking_confirmed': {
      const intro = 'Your payment was received and your court booking is confirmed.';
      const footer = 'Please arrive a few minutes early. See you on the court!';
      return {
        subject: `Booking confirmed: ${d.courtName}`,
        text: textBody(intro, d, p, footer),
        html: emailHtml('Your booking is confirmed', intro, d, p, footer),
        sms: fitSms((court) => `PickSched: Booking confirmed! ${court}, ${p.shortDate}, ${p.smsTime}. Ref ${p.reference}. See you on the court!`, d.courtName),
      };
    }
    case 'booking_received': {
      const intro = 'A player has booked and paid for one of your courts.';
      const footer = 'You can see all bookings in your PickSched facility schedule.';
      return {
        subject: `New paid booking: ${d.courtName}`,
        text: textBody(intro, d, p, footer),
        html: emailHtml('New paid booking', intro, d, p, footer),
        sms: fitSms((court) => `PickSched: New paid booking - ${court}, ${p.shortDate}, ${p.smsTime} (${p.smsAmount}). Ref ${p.reference}.`, d.courtName),
      };
    }
    case 'payment_refunded': {
      const intro = 'Your payment arrived after your hold on this slot expired, so the slot was released and we refunded your payment. Refunds can take several business days to appear.';
      const footer = 'We are sorry for the inconvenience. You can book another slot anytime.';
      return {
        subject: `Refund issued: ${d.courtName}`,
        text: textBody(intro, d, p, footer),
        html: emailHtml('Your payment was refunded', intro, d, p, footer),
        sms: fitSms((court) => `PickSched: Your payment for ${court}, ${p.shortDate} arrived after the hold expired and was refunded. Ref ${p.reference}.`, d.courtName),
      };
    }
    default:
      return { subject: 'PickSched update', text: 'You have an update on PickSched.', html: '<p>You have an update on PickSched.</p>', sms: 'PickSched: You have an update.' };
  }
}
