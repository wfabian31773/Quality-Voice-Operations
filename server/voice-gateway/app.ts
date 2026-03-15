import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import healthRoutes from './routes/health';
import twilioRoutes from './routes/twilio';
import adminConnectorRoutes from './routes/adminConnectors';
import { logError } from '../../platform/core/observability';
import { createLogger } from '../../platform/core/logger';

const logger = createLogger('VOICE_GATEWAY_APP');

const app: express.Application = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/', healthRoutes);
app.use('/', twilioRoutes);
app.use('/', adminConnectorRoutes);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled route error', { error: err.message, stack: err.stack });
  logError(null, 'error', err.message, {
    service: 'voice-gateway',
    stackTrace: err.stack,
    extra: { type: 'expressMiddleware' },
  }).catch(() => {});
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default app;
