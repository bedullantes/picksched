import { defineConfig, devices } from '@playwright/test';
import {
  APP_PORT, APP_URL, DATABASE_URL, MESSAGING_PORT, MESSAGING_URL, PAYMONGO_PORT, PAYMONGO_URL, SECRETS,
} from './env';

/*
 * End-to-end QA suite. Runs the production build of the API + web app against
 * a fresh PostgreSQL database, with local stand-ins for PayMongo, SendGrid and
 * Twilio (the same simulators the API tests use).
 *
 *   npm run test:e2e          (builds first; needs E2E_ADMIN_DATABASE_URL)
 *
 * Tests share one database and run one at a time; each uses its own users,
 * dates or courts so results don't interfere.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'Asia/Manila',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /reconciliation\.spec\.ts/ },
    // The booking journey also runs on a phone-sized touch device.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /booking-journey\.spec\.ts/ },
    // Last: reconcile dashboard figures with everything the suite booked and paid.
    { name: 'reconciliation', testMatch: /reconciliation\.spec\.ts/, dependencies: ['desktop', 'mobile'] },
  ],
  webServer: [
    {
      command: 'npx tsx ../api/scripts/fake-paymongo.ts',
      url: `${PAYMONGO_URL}/v1/checkout_sessions`, // 401 without a key means it's up
      env: {
        FAKE_PAYMONGO_PORT: String(PAYMONGO_PORT),
        PAYMONGO_SECRET_KEY: SECRETS.paymongoKey,
        PAYMONGO_WEBHOOK_SECRET: SECRETS.paymongoWebhook,
        WEBHOOK_URL: `${APP_URL}/api/webhooks/paymongo`,
      },
      reuseExistingServer: false,
    },
    {
      command: 'npx tsx ../api/scripts/fake-messaging.ts',
      url: `${MESSAGING_URL}/_sent`,
      env: {
        FAKE_MESSAGING_PORT: String(MESSAGING_PORT),
        SENDGRID_API_KEY: SECRETS.sendgridKey,
        TWILIO_ACCOUNT_SID: SECRETS.twilioSid,
        TWILIO_AUTH_TOKEN: SECRETS.twilioToken,
      },
      reuseExistingServer: false,
    },
    {
      command: 'npx tsx scripts/prepare-db.ts && node ../api/dist/server.js',
      url: `${APP_URL}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      env: {
        NODE_ENV: 'test', // development rules, but no api/.env.* files: everything is set here
        DATABASE_URL,
        PORT: String(APP_PORT),
        SESSION_SECRET: 'e2e-session-secret-e2e-session-secret',
        WEB_DIST: '../web/dist',
        BCRYPT_ROUNDS: '8',
        HOLD_SWEEP_INTERVAL_MS: '1000',
        PAYMENT_JOB_INTERVAL_MS: '1000',
        NOTIFICATIONS_INTERVAL_MS: '1000',
        APP_BASE_URL: APP_URL,
        PAYMONGO_SECRET_KEY: SECRETS.paymongoKey,
        PAYMONGO_WEBHOOK_SECRET: SECRETS.paymongoWebhook,
        PAYMONGO_API_BASE: `${PAYMONGO_URL}/v1`,
        SENDGRID_API_KEY: SECRETS.sendgridKey,
        SENDGRID_FROM_EMAIL: 'bookings@picksched.test',
        SENDGRID_API_BASE: MESSAGING_URL,
        TWILIO_ACCOUNT_SID: SECRETS.twilioSid,
        TWILIO_AUTH_TOKEN: SECRETS.twilioToken,
        TWILIO_MESSAGING_SERVICE_SID: 'MGe2e',
        TWILIO_API_BASE: MESSAGING_URL,
      },
    },
  ],
});
