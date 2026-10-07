import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Minimal PayMongo REST client: Checkout Sessions (hosted GCash / Maya
 * checkout), refunds, and webhook signature verification.
 * API reference: https://developers.paymongo.com/reference
 * Amounts are integers in centavos throughout.
 */

export interface PayMongoPayment {
  id: string;
  status: string; // 'paid' | 'failed' | 'pending'
  amount: number;
  fee: number | null;
  method: 'gcash' | 'paymaya' | null;
  paymentIntentId: string | null;
  failedCode: string | null;
  failedMessage: string | null;
  raw: unknown;
}

export interface CheckoutSession {
  id: string;
  status: string; // 'active' | 'expired' | ...
  checkoutUrl: string;
  paymentIntentId: string;
  payments: PayMongoPayment[];
  raw: unknown;
}

export interface CreateCheckoutSessionInput {
  amount: number;
  currency: string;
  name: string;
  description: string;
  referenceNumber: string;
  successUrl: string;
  cancelUrl: string;
  methods: string[];
  metadata: Record<string, string>;
}

export class PayMongoError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'network' | 'api',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

type Resource = { id: string; attributes: Record<string, any> };

export function parsePayment(resource: Resource): PayMongoPayment {
  const a = resource.attributes ?? {};
  const type = a.source?.type;
  return {
    id: resource.id,
    status: a.status,
    amount: a.amount,
    fee: typeof a.fee === 'number' ? a.fee : null,
    method: type === 'gcash' || type === 'paymaya' ? type : null,
    paymentIntentId: a.payment_intent_id ?? null,
    failedCode: a.failed_code ?? null,
    failedMessage: a.failed_message ?? null,
    raw: resource,
  };
}

export function parseCheckoutSession(resource: Resource): CheckoutSession {
  const a = resource.attributes ?? {};
  return {
    id: resource.id,
    status: a.status,
    checkoutUrl: a.checkout_url,
    paymentIntentId: a.payment_intent?.id,
    payments: (a.payments ?? []).map(parsePayment),
    raw: resource,
  };
}

export class PayMongoClient {
  constructor(private readonly opts: { secretKey: string; apiBase: string; timeoutMs: number }) {}

  private async request(method: string, path: string, body?: unknown): Promise<Resource> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.opts.secretKey}:`).toString('base64')}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new PayMongoError('timeout', `PayMongo ${method} ${path} timed out after ${this.opts.timeoutMs}ms`);
      }
      throw new PayMongoError('network', `PayMongo ${method} ${path} failed: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as { data?: Resource; errors?: Array<{ detail?: string }> } | null;
    if (!res.ok || !json?.data) {
      const detail = json?.errors?.map((e) => e.detail).filter(Boolean).join('; ') || res.statusText;
      throw new PayMongoError('api', `PayMongo ${method} ${path} returned ${res.status}: ${detail}`, res.status);
    }
    return json.data;
  }

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSession> {
    const data = await this.request('POST', '/checkout_sessions', {
      data: {
        attributes: {
          line_items: [{ currency: input.currency, amount: input.amount, name: input.name, quantity: 1 }],
          payment_method_types: input.methods,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          description: input.description,
          reference_number: input.referenceNumber,
          show_description: true,
          show_line_items: true,
          send_email_receipt: false,
          metadata: input.metadata,
        },
      },
    });
    return parseCheckoutSession(data);
  }

  async retrieveCheckoutSession(id: string): Promise<CheckoutSession> {
    return parseCheckoutSession(await this.request('GET', `/checkout_sessions/${encodeURIComponent(id)}`));
  }

  async expireCheckoutSession(id: string): Promise<CheckoutSession> {
    return parseCheckoutSession(await this.request('POST', `/checkout_sessions/${encodeURIComponent(id)}/expire`));
  }

  async createRefund(input: { paymentId: string; amount: number; notes: string }): Promise<{ id: string; raw: unknown }> {
    const data = await this.request('POST', '/refunds', {
      data: { attributes: { payment_id: input.paymentId, amount: input.amount, reason: 'others', notes: input.notes } },
    });
    return { id: data.id, raw: data };
  }
}

/**
 * Verifies a PayMongo webhook. The Paymongo-Signature header looks like
 * "t=<unix seconds>,te=<test signature>,li=<live signature>", where each
 * signature is HMAC-SHA256(webhook secret, "<t>.<raw body>") in hex.
 * Rejects stale timestamps to block replays.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  opts: { live: boolean; toleranceSeconds?: number; nowSeconds?: number },
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: 'missing signature header' };
  const parts = Object.fromEntries(header.split(',').map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
  }));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'missing timestamp' };
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (opts.toleranceSeconds ?? 300)) return { ok: false, reason: 'stale timestamp' };

  const given = opts.live ? parts.li : parts.te;
  if (!given || !/^[0-9a-f]+$/i.test(given)) return { ok: false, reason: 'missing signature' };
  const expected = createHmac('sha256', secret).update(`${parts.t}.`).update(rawBody).digest();
  const givenBuf = Buffer.from(given, 'hex');
  if (givenBuf.length !== expected.length || !timingSafeEqual(givenBuf, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

/** Signs a payload the way PayMongo does (used by tests and the local fake). */
export function signWebhook(rawBody: string, secret: string, live = false, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},te=${live ? '' : sig},li=${live ? sig : ''}`;
}
