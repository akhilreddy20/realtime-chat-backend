import http from 'node:http';
import { config, assertConfig } from './config/index.js';
import { connectDB, disconnectDB } from './lib/db.js';
import { createApp } from './app.js';
import { createRealtime } from './realtime/socket.js';
import { logger } from './lib/logger.js';

const start = async () => {
  assertConfig();
  await connectDB(config.mongoUri); // connect BEFORE accepting traffic

  // Socket.IO must attach after the request handler exists (it wraps it to
  // intercept /socket.io/*), but the app needs to emit through Socket.IO,
  // so the app gets a thin delegate that resolves the realtime layer lazily.
  let realtime;
  const app = createApp({
    realtime: {
      isOnline: (userId) => realtime.isOnline(userId),
      emitToUser: (...args) => realtime.emitToUser(...args),
    },
  });
  const server = http.createServer(app);
  realtime = createRealtime(server);
  server.listen(config.port, () => logger.info('server listening', { port: config.port, env: config.env }));

  const shutdown = async (signal) => {
    logger.info('shutting down', { signal });
    setTimeout(() => process.exit(1), 10_000).unref();
    await realtime.close(); // also closes the HTTP server
    await disconnectDB();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

start().catch((err) => {
  logger.error('failed to start', { err: err.message });
  process.exit(1);
});
