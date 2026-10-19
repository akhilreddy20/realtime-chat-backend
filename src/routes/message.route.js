import express from 'express';
import { protectRoute } from '../middleware/auth.middleware.js';
import { uploadImage } from '../lib/images.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import {
  validateMessageInput,
  sendMessage,
  listMessages,
  markConversationRead,
} from '../services/message.service.js';

export const messageRouter = ({ realtime, sendLimiter = createRateLimiter({ windowMs: 10_000, max: 30 }) }) => {
  const router = express.Router();
  router.use(protectRoute);

  // GET /api/messages/:userId?before=<messageId>&limit=30
  router.get('/:userId', async (req, res) => {
    const { before, limit } = req.query;
    res.json(await listMessages({ me: req.user._id, peerId: req.params.userId, before, limit }));
  });

  // POST /api/messages/:userId  { text?, image?, clientMessageId? }
  router.post('/:userId', sendLimiter.middleware((req) => String(req.user._id)), async (req, res) => {
    const input = validateMessageInput(req.body ?? {});
    const image = input.image ? await uploadImage(input.image, 'chat/messages') : undefined;

    const { message, created } = await sendMessage({
      senderId: req.user._id,
      receiverId: req.params.userId,
      text: input.text,
      image,
      clientMessageId: input.clientMessageId,
    });

    if (created) {
      // Deliver to every tab of both participants (the sender's other tabs stay in sync too).
      realtime.emitToUser(message.receiverId, 'message:new', message);
      realtime.emitToUser(message.senderId, 'message:new', message);
    } else {
      res.set('Idempotent-Replayed', 'true');
    }
    res.status(created ? 201 : 200).json(message);
  });

  // POST /api/messages/:userId/read — mark everything they sent me as read.
  router.post('/:userId/read', async (req, res) => {
    const { ids, readAt } = await markConversationRead({ me: req.user._id, peerId: req.params.userId });
    if (ids.length) {
      realtime.emitToUser(req.params.userId, 'messages:read', { by: String(req.user._id), ids, readAt });
    }
    res.json({ updated: ids.length, readAt });
  });

  return router;
};
