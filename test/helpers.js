import http from 'node:http';
import mongoose from 'mongoose';
import path from 'node:path';
import { createRequire } from 'node:module';

// Use the browser client bundled inside the `socket.io` package (no extra
// dependency). Its UMD build loads as CommonJS and runs on Node 22+, which
// has a global WebSocket.
const require = createRequire(import.meta.url);
const socketIoDir = path.resolve(path.dirname(require.resolve('socket.io')), '..');
const ioClient = require(path.join(socketIoDir, 'client-dist/socket.io.js'));

process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const { createApp } = await import('../src/app.js');
const { createRealtime } = await import('../src/realtime/socket.js');
const { createRateLimiter } = await import('../src/lib/rateLimit.js');

export const MONGO = process.env.MONGODB_URI_TEST;

export const connect = async () => {
  await mongoose.connect(MONGO);
  await mongoose.connection.db.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
};

export const disconnect = async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
};

/** Full stack (HTTP + Socket.IO) on an ephemeral port. */
export const startServer = async ({ limiters } = {}) => {
  let realtime;
  const app = createApp({
    realtime: { isOnline: (id) => realtime.isOnline(id), emitToUser: (...a) => realtime.emitToUser(...a) },
    limiters: limiters ?? {
      auth: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      send: createRateLimiter({ windowMs: 60_000, max: 1000 }),
    },
  });
  const server = http.createServer(app);
  realtime = createRealtime(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => realtime.close() };
};

/** Tiny HTTP client that keeps the session cookie like a browser would. */
export const client = (base) => {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return { call, get cookie() { return cookie; } };
};

export const signup = async (base, name) => {
  const c = client(base);
  const res = await c.call('POST', '/api/auth/signup', {
    fullName: name, email: `${name.toLowerCase()}@test.io`, password: 'password123',
  });
  if (res.status !== 201) throw new Error(`signup ${name}: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...c, user: res.body };
};

/**
 * Connects like a non-browser client: the session JWT goes in `auth.token`
 * (browsers send the httpOnly cookie automatically instead).
 * `cookie` is the "jwt=<token>" string kept by `client()`.
 */
export const connectSocket = (base, cookie, opts = {}) =>
  new Promise((resolve, reject) => {
    const token = cookie ? cookie.replace(/^jwt=/, '') : undefined;
    const socket = ioClient(base, {
      transports: ['websocket'],
      auth: token ? { token } : {},
      reconnection: false,
      forceNew: true,
      ...opts,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

export const nextEvent = (socket, event, timeoutMs = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });

/** Resolves true if the event does NOT arrive within the window. */
export const noEvent = (socket, event, windowMs = 300) =>
  new Promise((resolve) => {
    const handler = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { socket.off(event, handler); resolve(true); }, windowMs);
    socket.once(event, handler);
  });
