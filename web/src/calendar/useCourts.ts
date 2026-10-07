import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { Court } from '../api/types';

/** Courts shown in the calendar: an owner's own courts, or every active court for players. */
export function useCourts(ownedOnly: boolean) {
  const [courts, setCourts] = useState<Court[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ courts: Court[] }>('/api/courts', { query: { mine: ownedOnly ? '1' : undefined } });
      setCourts(res.courts);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', 'Could not load courts.'));
    }
  }, [ownedOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  return { courts, error, reload: load };
}
