/** Shared settings for the end-to-end stack (used by the config, setup script and tests). */
export const ADMIN_DATABASE_URL = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
export const DATABASE_NAME = process.env.E2E_DATABASE_NAME ?? 'picksched_e2e_test';
export const DATABASE_URL = (() => {
  const u = new URL(ADMIN_DATABASE_URL);
  u.pathname = `/${DATABASE_NAME}`;
  return u.toString();
})();

export const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3100);
export const PAYMONGO_PORT = Number(process.env.E2E_PAYMONGO_PORT ?? 4110);
export const MESSAGING_PORT = Number(process.env.E2E_MESSAGING_PORT ?? 4120);
export const APP_URL = `http://localhost:${APP_PORT}`;
export const PAYMONGO_URL = `http://127.0.0.1:${PAYMONGO_PORT}`;
export const MESSAGING_URL = `http://127.0.0.1:${MESSAGING_PORT}`;

export const SECRETS = {
  paymongoKey: 'sk_test_e2e',
  paymongoWebhook: 'whsk_e2e',
  sendgridKey: 'SG.e2e',
  twilioSid: 'ACe2e',
  twilioToken: 'e2e-token',
};

/** Demo accounts created by `npm run seed:demo` (password for all: pickleball123). */
export const DEMO = { owner: 'owner@demo.test', player: 'player@demo.test', player2: 'player2@demo.test', password: 'pickleball123' };
