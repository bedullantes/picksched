/**
 * Thin fetch wrapper. Every failure becomes an ApiError whose `message` is
 * safe to show to users as-is.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }

  /** The request never reached the server, or got no answer in time. */
  get isConnectivity() {
    return this.code === 'NETWORK' || this.code === 'TIMEOUT';
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000;

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const FALLBACK: Record<number, string> = {
  401: 'Please sign in to continue.',
  403: "You don't have permission to do that.",
  404: 'Not found.',
  409: 'That change conflicts with the latest schedule. Please refresh and try again.',
  503: 'The booking service is temporarily unavailable. Please try again shortly.',
};

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  opts.signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: timeout.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err; // caller cancelled; not an error to report
    if (timeout.signal.aborted) {
      throw new ApiError(0, 'TIMEOUT', 'The server took too long to respond. Please try again.');
    }
    throw new ApiError(0, 'NETWORK', "Can't reach PickSched. Check your internet connection and try again.");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  if (res.status === 204) return undefined as T;
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON (e.g. a proxy error page)
  }
  if (!res.ok) {
    const message = data?.error?.message
      ?? FALLBACK[res.status]
      ?? (res.status >= 500 ? 'Something went wrong on our side. Please try again.' : 'The request could not be completed.');
    throw new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, message);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please try again.';
}
