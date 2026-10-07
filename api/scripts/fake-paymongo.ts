/**
 * Runs the local PayMongo simulator for development without PayMongo keys.
 *   npm run dev:paymongo -w api
 * Then start the API with:
 *   PAYMONGO_SECRET_KEY=sk_test_local PAYMONGO_WEBHOOK_SECRET=whsk_local
 *   PAYMONGO_API_BASE=http://localhost:4010/v1 APP_BASE_URL=http://localhost:5173
 */
import { startFakePayMongo } from '../test/fake-paymongo.js';

const port = Number(process.env.FAKE_PAYMONGO_PORT ?? 4010);
const fake = await startFakePayMongo({
  port,
  secretKey: process.env.PAYMONGO_SECRET_KEY ?? 'sk_test_local',
  webhookSecret: process.env.PAYMONGO_WEBHOOK_SECRET ?? 'whsk_local',
  webhookUrl: process.env.WEBHOOK_URL ?? 'http://localhost:3000/api/webhooks/paymongo',
});
console.log(`PayMongo simulator on ${fake.baseUrl} (API ${fake.apiBase}); webhooks -> ${fake.state.webhookUrl}`);
