import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { sessionMiddleware } from './auth.js';
import type { Deps } from './context.js';
import { ApiError, errorHandler } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { availabilityRoutes } from './routes/availability.js';
import { bookingRoutes } from './routes/bookings.js';
import { courtRoutes } from './routes/courts.js';
import { eventRoutes } from './routes/events.js';
import { maintenanceRoutes } from './routes/maintenance.js';

export function createApp(deps: Deps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));
  app.use(sessionMiddleware(deps.config.sessionSecret));

  app.get('/api/health', async (_req, res) => {
    await deps.db.query('SELECT 1');
    res.json({ ok: true });
  });
  app.use('/api/auth', authRoutes(deps));
  app.use('/api/courts', courtRoutes(deps));
  app.use('/api/availability', availabilityRoutes(deps));
  app.use('/api/bookings', bookingRoutes(deps));
  app.use('/api/maintenance-blocks', maintenanceRoutes(deps));
  app.use('/api/events', eventRoutes(deps));
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Not found.')));

  // In production, serve the built web app from the same origin.
  if (deps.config.webDist && existsSync(deps.config.webDist)) {
    const dist = path.resolve(deps.config.webDist);
    app.use(express.static(dist, { index: false }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
