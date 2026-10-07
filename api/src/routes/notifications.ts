import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { asUser, type Deps } from '../context.js';
import { renderNotification } from '../notifications.js';

/** GET /api/notifications — the signed-in user's recent notifications (in-app inbox). */
export function notificationRoutes(deps: Deps) {
  const r = Router();
  r.get('/', requireAuth, async (req, res) => {
    const rows = await asUser(deps, req, async (tx) => (await tx.query(
      `SELECT id, kind, booking_id, payload, created_at, sent_at
       FROM notifications ORDER BY created_at DESC LIMIT 50`)).rows);
    res.json({
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        bookingId: n.booking_id,
        ...renderNotification(n.kind, n.payload),
        createdAt: n.created_at.toISOString(),
        sentAt: n.sent_at?.toISOString() ?? null,
      })),
    });
  });
  return r;
}
