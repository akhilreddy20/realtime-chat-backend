import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { authRouter } from './routes/auth.route.js';
import { userRouter } from './routes/user.route.js';
import { messageRouter } from './routes/message.route.js';
import { nullRealtime } from './realtime/socket.js';
import { HttpError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { config } from './config/index.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export const createApp = ({ realtime = nullRealtime, limiters = {} } = {}) => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // correct req.ip behind Render/Heroku-style proxies

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });

  // CORS for API clients on other origins (the bundled web client is same-origin).
  app.use('/api', (req, res, next) => {
    const { origin } = req.headers;
    if (origin && config.corsOrigins.includes(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        Vary: 'Origin',
      });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  // Images arrive as base64 data URLs (~1.37x their size), so allow a bit over 2 MB.
  app.use(express.json({ limit: '3mb' }));
  app.use(cookieParser());

  app.get('/health', (req, res) => {
    const db = mongoose.connection.readyState === 1 ? 'up' : 'down';
    res.status(db === 'up' ? 200 : 503).json({ status: db === 'up' ? 'ok' : 'degraded', db });
  });

  app.use('/api/auth', authRouter({ authLimiter: limiters.auth }));
  app.use('/api/users', userRouter({ realtime }));
  app.use('/api/messages', messageRouter({ realtime, sendLimiter: limiters.send }));
  app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));

  app.use(express.static(publicDir));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ message: err.message, details: err.details });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Malformed JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ message: 'Request body too large' });
    if (err.name === 'ValidationError') return res.status(400).json({ message: err.message });
    if (err.code === 11000) return res.status(409).json({ message: 'Duplicate value' });
    logger.error('unhandled error', { path: req.path, err: err.stack });
    return res.status(500).json({ message: 'Internal server error' });
  });

  return app;
};
