import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { sessionMiddleware } from './auth.js';
import type { Deps } from './context.js';
import { ApiError, errorHandler } from './errors.js';
import { accessLog, httpsRedirect, requestId, securityHeaders } from './security.js';
import { authRoutes } from './routes/auth.js';
import { availabilityRoutes } from './routes/availability.js';
import { bookingRoutes } from './routes/bookings.js';
import { courtRoutes } from './routes/courts.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { eventRoutes } from './routes/events.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { notificationRoutes } from './routes/notifications.js';
import { webhookRoutes } from './routes/webhooks.js';

export function createApp(deps: Deps) {
  const app = express();
  app.disable('x-powered-by');
  const { security, logging } = deps.config;
  app.set('trust proxy', security.trustProxy);
  app.use(requestId());
  if (logging.accessLog) app.use(accessLog());
  app.use(securityHeaders(security));
  if (security.httpsRedirect) app.use(httpsRedirect(security.publicUrl));
  // Webhooks verify signatures over the raw body, so they're mounted before the JSON parser.
  app.use('/api/webhooks', webhookRoutes(deps));
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
  app.use('/api/notifications', notificationRoutes(deps));
  app.use('/api/dashboard', dashboardRoutes(deps));
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Not found.')));

  // In production, serve the built web app from the same origin.
  if (deps.config.webDist && existsSync(deps.config.webDist)) {
    const dist = path.resolve(deps.config.webDist);
    app.use(express.static(dist, {
      index: false,
      setHeaders: (res, file) => {
        // Vite fingerprints everything under assets/, so those files never change.
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
