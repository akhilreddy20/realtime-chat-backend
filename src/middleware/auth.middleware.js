import mongoose from 'mongoose';
import { tokenFromRequest, verifyToken } from '../lib/auth.js';
import { User } from '../models/user.model.js';
import { unauthorized } from '../lib/errors.js';

/** Requires a valid session; sets req.user. Invalid/expired tokens are 401, not 500. */
export const protectRoute = async (req, res, next) => {
  const userId = verifyToken(tokenFromRequest(req));
  if (!userId || !mongoose.isValidObjectId(userId)) throw unauthorized();
  const user = await User.findById(userId);
  if (!user) throw unauthorized();
  req.user = user;
  next();
};
