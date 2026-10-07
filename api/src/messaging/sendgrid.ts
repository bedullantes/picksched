import { deliveryFetch, DeliveryError, isRetryableStatus } from './errors.js';

/*
 * SendGrid Mail Send API (v3): POST /v3/mail/send
 * https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
 */

export interface SendGridConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  apiBase: string;
  timeoutMs: number;
  /** SendGrid validates the request but delivers nothing (for staging). */
  sandbox: boolean;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
  category: string;
  customArgs?: Record<string, string>;
}

export class SendGridClient {
  constructor(private readonly cfg: SendGridConfig) {}

  /** Sends one email. Returns SendGrid's message id (X-Message-Id). */
  async send(email: Email): Promise<{ messageId: string | undefined }> {
    const res = await deliveryFetch('SendGrid', `${this.cfg.apiBase}/v3/mail/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: email.to }], custom_args: email.customArgs }],
        from: { email: this.cfg.fromEmail, name: this.cfg.fromName },
        subject: email.subject,
        content: [
          { type: 'text/plain', value: email.text },
          { type: 'text/html', value: email.html },
        ],
        categories: ['picksched', email.category],
        // Transactional mail: keep links untouched so they don't look like tracking redirects.
        tracking_settings: { click_tracking: { enable: false, enable_text: false } },
        ...(this.cfg.sandbox ? { mail_settings: { sandbox_mode: { enable: true } } } : {}),
      }),
    }, this.cfg.timeoutMs);

    if (res.status === 202 || res.status === 200) {
      return { messageId: res.headers.get('x-message-id') ?? undefined };
    }
    const body = (await res.json().catch(() => null)) as { errors?: Array<{ message?: string }> } | null;
    const detail = body?.errors?.map((e) => e.message).filter(Boolean).join('; ') || res.statusText;
    throw new DeliveryError(`SendGrid returned ${res.status}: ${detail}`, !isRetryableStatus(res.status));
  }
}
