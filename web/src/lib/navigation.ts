/** Full-page navigation to another site (e.g. PayMongo checkout). Separate so tests can stub it. */
export function redirectTo(url: string): void {
  window.location.assign(url);
}

export const METHOD_LABELS: Record<string, string> = { gcash: 'GCash', paymaya: 'Maya' };
