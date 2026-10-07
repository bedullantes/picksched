import { createHmac, timingSafeEqual } from 'node:crypto';
import { deliveryFetch, DeliveryError, isRetryableStatus } from './errors.js';

/*
 * Twilio Programmable Messaging: POST /2010-04-01/Accounts/{Sid}/Messages.json
 * https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
 */

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Preferred: a Messaging Service (sender pool, carrier-specific routing). */
  messagingServiceSid?: string;
  /** Used when there's no Messaging Service. */
  fromNumber?: string;
  apiBase: string;
  timeoutMs: number;
  /** Public URL of /api/webhooks/twilio/status, for delivery receipts. */
  statusCallbackUrl?: string;
}

export class TwilioClient {
  constructor(private readonly cfg: TwilioConfig) {}

  /** Sends one SMS. Returns Twilio's message SID. */
  async sendSms(to: string, body: string): Promise<{ messageId: string }> {
    const form = new URLSearchParams({ To: to, Body: body });
    if (this.cfg.messagingServiceSid) form.set('MessagingServiceSid', this.cfg.messagingServiceSid);
    else form.set('From', this.cfg.fromNumber!);
    if (this.cfg.statusCallbackUrl) form.set('StatusCallback', this.cfg.statusCallbackUrl);

    const res = await deliveryFetch('Twilio',
      `${this.cfg.apiBase}/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      }, this.cfg.timeoutMs);

    const json = (await res.json().catch(() => null)) as { sid?: string; code?: number; message?: string } | null;
    if (res.status === 201 && json?.sid) return { messageId: json.sid };
    const detail = json?.code ? `${json.code} ${json.message ?? ''}`.trim() : res.statusText;
    // 4xx from Twilio means the request itself is wrong (invalid or unsubscribed number,
    // unsupported region...), so retrying won't help.
    throw new DeliveryError(`Twilio returned ${res.status}: ${detail}`, !isRetryableStatus(res.status));
  }
}

/**
 * Validates X-Twilio-Signature on a webhook: base64(HMAC-SHA1(auth token,
 * full URL + each POST parameter name and value, sorted by name)).
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function verifyTwilioSignature(
  authToken: string, url: string, params: Record<string, string>, signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
