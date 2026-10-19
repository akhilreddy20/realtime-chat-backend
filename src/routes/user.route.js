import express from 'express';
import { protectRoute } from '../middleware/auth.middleware.js';
import { listContacts } from '../services/message.service.js';

export const userRouter = ({ realtime }) => {
  const router = express.Router();

  // Contacts with online status, last message and unread count.
  router.get('/', protectRoute, async (req, res) => {
    const contacts = await listContacts({ me: req.user._id });
    res.json(contacts.map((c) => ({ ...c, online: realtime.isOnline(c._id) })));
  });

  return router;
};
