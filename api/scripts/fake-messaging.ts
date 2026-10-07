/**
 * Runs local SendGrid + Twilio stand-ins for development without real keys.
 *   npm run dev:messaging -w api
 * Then start the API with:
 *   SENDGRID_API_KEY=SG.local SENDGRID_FROM_EMAIL=bookings@localhost SENDGRID_API_BASE=http://localhost:4020
 *   TWILIO_ACCOUNT_SID=AClocal TWILIO_AUTH_TOKEN=local TWILIO_FROM_NUMBER=+15005550006 TWILIO_API_BASE=http://localhost:4020
 * Sent messages are listed at http://localhost:4020/_sent
 */
import { startFakeMessaging } from '../test/fake-messaging.js';

const fake = await startFakeMessaging({
  port: Number(process.env.FAKE_MESSAGING_PORT ?? 4020),
  sendgridKey: process.env.SENDGRID_API_KEY ?? 'SG.local',
  twilioSid: process.env.TWILIO_ACCOUNT_SID ?? 'AClocal',
  twilioToken: process.env.TWILIO_AUTH_TOKEN ?? 'local',
});
console.log(`SendGrid/Twilio simulator on ${fake.baseUrl}; sent messages at ${fake.baseUrl}/_sent`);
