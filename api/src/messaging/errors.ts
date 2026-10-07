/** A failed send. `permanent` errors (bad address, rejected content) are not retried. */
export class DeliveryError extends Error {
  constructor(message: string, public readonly permanent: boolean) {
    super(message);
  }
}

/** Shared fetch with timeout; network errors and timeouts are retryable. */
export async function deliveryFetch(service: string, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as Error).name;
    const what = name === 'TimeoutError' || name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err as Error).message;
    throw new DeliveryError(`${service} request ${what}`, false);
  }
}

/** 429 and 5xx are worth retrying; other 4xx responses are not. */
export const isRetryableStatus = (status: number) => status === 429 || status >= 500;
