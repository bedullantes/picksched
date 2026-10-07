/**
 * QA-01 Player booking journey: Search > Select > Payment > Confirmation.
 * Runs on desktop and on a phone (see playwright.config.ts projects).
 */
import { expect, test } from '@playwright/test';
import {
  bookingRow, goToPayMongo, localDate, messagesFor, openDate, registerViaUi, reserve, slot, sql, uniqueEmail, DEMO,
} from './support';

test('a player finds a slot, pays with GCash and gets a confirmed booking', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile';
  const court = mobile ? 'Court 2' : 'Court 1';
  const time = mobile ? '10:00 AM' : '9:00 AM';
  const phone = mobile ? '0917 555 0102' : '0917 555 0101';
  const e164 = `+63${phone.replace(/\D/g, '').slice(1)}`;
  const date = await localDate(2);
  const email = uniqueEmail(`journey-${info.project.name}`);
  const startedAt = Date.now();

  await test.step('sign up as a player with a mobile number', async () => {
    await registerViaUi(page, { email, phone });
    await expect(page.getByRole('heading', { name: 'Book a court' })).toBeVisible();
  });

  await test.step('Search: choose a date and see open slots', async () => {
    await openDate(page, date);
    await expect(slot(page, court, time)).toHaveAccessibleName(/Available/);
    if (mobile) {
      // No sideways scrolling on a phone.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }
  });

  let bookingId = '';
  await test.step('Select: reserve the slot (held as pending_payment)', async () => {
    bookingId = await reserve(page, court, time);
    const b = await bookingRow(bookingId);
    expect(b.status).toBe('pending_payment');
    expect(b.payment_status).toBe('unpaid');
    expect(b.expires_at).not.toBeNull();
    await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  });

  await test.step('Payment: pay with GCash on PayMongo', async () => {
    await goToPayMongo(page);
    // Still pending while the player is on PayMongo: confirmation only comes from the webhook.
    const during = await bookingRow(bookingId);
    expect(during.status).toBe('pending_payment');
    expect(during.payment_intent_id).toMatch(/^pi_/);
    await page.getByRole('button', { name: 'Pay with GCash' }).click();
  });

  await test.step('Confirmation: success screen and a confirmed, paid booking', async () => {
    await page.waitForURL(`**/bookings/${bookingId}/payment?result=success`);
    await expect(page.getByRole('heading', { name: 'Payment successful' })).toBeVisible();
    const b = await bookingRow(bookingId);
    expect(b).toMatchObject({ status: 'confirmed', payment_status: 'paid', tx_status: 'paid', payment_method: 'gcash' });
    expect(Number(b.tx_amount)).toBe(Number(b.total_amount));
    expect(Number(b.platform_fee)).toBe(Math.round(Number(b.total_amount) * 0.05));
    expect(Number(b.owner_net)).toBe(Number(b.tx_amount) - Number(b.platform_fee) - Number(b.provider_fee));
    // PayMongo's signed webhook was received and recorded for this payment.
    const [evt] = await sql(
      `SELECT count(*)::int AS n FROM payment_events e JOIN transactions t ON t.id = e.transaction_id
       WHERE t.booking_id = $1 AND e.type = 'checkout_session.payment.paid'`, [bookingId]);
    expect(evt.n).toBe(1);
  });

  await test.step('the calendar shows the slot as the player\'s booking', async () => {
    await page.getByRole('link', { name: 'Back to calendar' }).click();
    await openDate(page, date);
    await expect(slot(page, court, time)).toHaveAccessibleName(/Your booking, Confirmed/);
  });

  await test.step('email and SMS confirmations arrive within 2 minutes', async () => {
    await expect.poll(async () => {
      const m = await messagesFor(email);
      return m.emails.length;
    }, { timeout: 120_000 }).toBe(1);
    const mine = await messagesFor(email);
    const sms = await messagesFor(e164);
    expect(sms.sms).toHaveLength(1);
    const ref = `PS-${bookingId.slice(0, 8)}`;
    expect(mine.emails[0].subject).toBe(`Booking confirmed: ${court}`);
    expect(mine.emails[0].text.toLowerCase()).toContain(ref.toLowerCase());
    expect(sms.sms[0].body.toLowerCase()).toContain(ref.toLowerCase());
    expect(sms.sms[0].body).toContain(court);
    for (const sent of [...mine.emails, ...sms.sms]) expect(sent.receivedAt - startedAt).toBeLessThan(120_000);
    // The owner gets a "new paid booking" alert.
    const owner = await messagesFor(DEMO.owner);
    expect(owner.emails.some((e) => e.text.toLowerCase().includes(ref.toLowerCase()))).toBe(true);
    const rows = await sql(`SELECT channel, status FROM notifications WHERE booking_id = $1 ORDER BY kind, channel`, [bookingId]);
    expect(rows.every((r) => r.status === 'sent' || r.status === 'delivered')).toBe(true);
  });
});
