import express from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/user.model.js';
import { setAuthCookie, clearAuthCookie } from '../lib/auth.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { protectRoute } from '../middleware/auth.middleware.js';
import { uploadImage } from '../lib/images.js';
import { createRateLimiter } from '../lib/rateLimit.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Compared against when the email doesn't exist, so response time doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export const authRouter = ({ authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 }) } = {}) => {
  const router = express.Router();
  const limit = authLimiter.middleware((req) => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`);

  router.post('/signup', limit, async (req, res) => {
    const { fullName, email, password } = req.body ?? {};
    if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 60) {
      throw badRequest('fullName is required (max 60 characters)');
    }
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) throw badRequest('A valid email is required');
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      throw badRequest('password must be 8-72 characters');
    }
    if (await User.exists({ email: email.toLowerCase() })) throw conflict('Email is already registered');

    const user = await User.create({
      fullName: fullName.trim(),
      email,
      password: await bcrypt.hash(password, 10),
    });
    setAuthCookie(res, user._id);
    res.status(201).json(user.toPublic());
  });

  router.post('/login', limit, async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') throw badRequest('email and password are required');
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    const ok = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
    if (!user || !ok) throw unauthorized('Invalid email or password');
    setAuthCookie(res, user._id);
    res.json(user.toPublic());
  });

  router.post('/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ message: 'Logged out' });
  });

  router.get('/me', protectRoute, (req, res) => res.json(req.user.toPublic()));

  router.patch('/profile', protectRoute, async (req, res) => {
    const { fullName, profilePic } = req.body ?? {};
    const update = {};
    if (fullName !== undefined) {
      if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 60) {
        throw badRequest('fullName must be 1-60 characters');
      }
      update.fullName = fullName.trim();
    }
    if (profilePic !== undefined) update.profilePic = await uploadImage(profilePic, 'chat/avatars');
    if (!Object.keys(update).length) throw badRequest('Nothing to update');

    await User.updateOne({ _id: req.user._id }, { $set: update });
    const user = await User.findById(req.user._id);
    res.json(user.toPublic());
  });

  return router;
};
