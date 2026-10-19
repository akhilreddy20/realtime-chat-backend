import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { verifyToken, parseCookies, COOKIE_NAME } from '../lib/auth.js';
import { User } from '../models/user.model.js';
import { PresenceRegistry } from './presence.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { logger } from '../lib/logger.js';

const userRoom = (userId) => `user:${userId}`;

/**
 * Socket.IO layer.
 *
 * - Authenticates the handshake with the same JWT as the REST API (httpOnly
 *   cookie, or `auth.token` for non-browser clients). The original trusted a
 *   `?userId=` query param, so anyone could impersonate anyone.
 * - Each user joins a private room `user:<id>`, so an event reaches every
 *   tab/device of that user.
 */
export const createRealtime = (httpServer) => {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, credentials: true },
  });
  const presence = new PresenceRegistry();
  const typingLimiter = createRateLimiter({ windowMs: 1000, max: 10 });

  io.use(async (socket, next) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const userId = verifyToken(cookies[COOKIE_NAME] || socket.handshake.auth?.token);
    if (!userId || !mongoose.isValidObjectId(userId)) return next(new Error('unauthorized'));
    const user = await User.findById(userId).select('_id fullName');
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = String(user._id);
    return next();
  });

  io.on('connection', (socket) => {
    const { userId } = socket.data;
    socket.join(userRoom(userId));

    // Tell this socket who is online; tell everyone else if this user just came online.
    socket.emit('presence:online', presence.onlineUserIds().concat(presence.isOnline(userId) ? [] : [userId]));
    if (presence.add(userId, socket.id)) {
      socket.broadcast.emit('presence:update', { userId, online: true });
    }

    socket.on('typing', (payload = {}) => {
      const { to, isTyping } = payload;
      if (!mongoose.isValidObjectId(to) || to === userId) return;
      if (!typingLimiter.take(socket.id).allowed) return;
      io.to(userRoom(to)).emit('typing', { from: userId, isTyping: Boolean(isTyping) });
    });

    socket.on('disconnect', async () => {
      typingLimiter.take(socket.id); // no-op touch; entries expire on their own
      if (presence.remove(userId, socket.id)) {
        const lastSeenAt = new Date();
        io.emit('presence:update', { userId, online: false, lastSeenAt });
        try {
          await User.updateOne({ _id: userId }, { $set: { lastSeenAt } });
        } catch (err) {
          logger.warn('failed to store lastSeenAt', { userId, err: err.message });
        }
      }
    });
  });

  return {
    io,
    isOnline: (userId) => presence.isOnline(userId),
    emitToUser: (userId, event, payload) => io.to(userRoom(String(userId))).emit(event, payload),
    close: () => new Promise((resolve) => io.close(() => resolve())),
  };
};

/** No-op implementation used when the app runs without a socket server (unit tests). */
export const nullRealtime = {
  isOnline: () => false,
  emitToUser: () => {},
};
