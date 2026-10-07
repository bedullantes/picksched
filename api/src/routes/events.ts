import { Router } from 'express';
import { requireAuth } from '../auth.js';
import type { Deps } from '../context.js';
import type { ScheduleChange } from '../events.js';

/**
 * GET /api/events — Server-Sent Events stream of schedule changes.
 *   event: schedule-changed  data: {"courtId","startTime","endTime"}
 *   event: resync            data: {}   (refetch everything)
 * Payloads carry no personal data; clients refetch availability through
 * the normal, permission-checked endpoint.
 */
export function eventRoutes(deps: Deps, heartbeatMs = 25_000) {
  const r = Router();

  r.get('/', requireAuth, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\nevent: ready\ndata: {}\n\n');

    const onChange = (c: ScheduleChange) => res.write(`event: schedule-changed\ndata: ${JSON.stringify(c)}\n\n`);
    const onResync = () => res.write('event: resync\ndata: {}\n\n');
    deps.events.on('change', onChange);
    deps.events.on('resync', onResync);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);

    req.on('close', () => {
      clearInterval(heartbeat);
      deps.events.off('change', onChange);
      deps.events.off('resync', onResync);
    });
  });

  return r;
}
