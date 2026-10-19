import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Message, conversationIdFor } from '../models/message.model.js';
import { User } from '../models/user.model.js';
import { Conversation } from '../models/conversation.model.js';
import { badRequest, notFound } from '../lib/errors.js';
import { config } from '../config/index.js';

const { isValidObjectId } = mongoose;

export const validateMessageInput = ({ text, image, clientMessageId }) => {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (text !== undefined && typeof text !== 'string') throw badRequest('text must be a string');
  if (!trimmed && !image) throw badRequest('A message needs text or an image');
  if (trimmed.length > config.limits.messageText) {
    throw badRequest(`text must be at most ${config.limits.messageText} characters`);
  }
  if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || !/^[\w-]{8,64}$/.test(clientMessageId))) {
    throw badRequest('clientMessageId must be 8-64 characters of [A-Za-z0-9_-]');
  }
  return { text: trimmed || undefined, image, clientMessageId };
};

const assertPeer = async (me, peerId) => {
  if (!isValidObjectId(peerId)) throw badRequest('Invalid user id');
  if (String(me) === String(peerId)) throw badRequest('You cannot message yourself');
  if (!(await User.exists({ _id: peerId }))) throw notFound('User not found');
};

/**
 * Keeps the conversation's denormalized lastMessage up to date.
 * The conditional filter only moves lastMessage forward, so two messages
 * finishing out of order can't leave an older one as "latest".
 */
const touchConversation = async (message) => {
  const _id = message.conversationId;
  const lastMessage = {
    _id: message._id,
    senderId: message.senderId,
    text: message.text,
    hasImage: Boolean(message.image),
    createdAt: message.createdAt,
  };
  try {
    await Conversation.updateOne(
      { _id },
      { $setOnInsert: { participants: [message.senderId, message.receiverId] } },
      { upsert: true }
    );
  } catch (err) {
    if (err?.code !== 11000) throw err; // concurrent first messages: the other insert won
  }
  await Conversation.updateOne(
    { _id, $or: [{ 'lastMessage._id': { $exists: false } }, { 'lastMessage._id': { $lt: message._id } }] },
    { $set: { lastMessage } }
  );
};

/**
 * Creates a message exactly once per (sender, clientMessageId).
 * A retried request with the same clientMessageId returns the stored message
 * with created=false. The unique index makes this safe under concurrency: the
 * second insert fails with E11000 and we return the winner instead.
 */
export const sendMessage = async ({ senderId, receiverId, text, image, clientMessageId }) => {
  await assertPeer(senderId, receiverId);

  if (clientMessageId) {
    const existing = await Message.findOne({ senderId, clientMessageId });
    if (existing) return { message: existing, created: false };
  }
  const idempotencyKey = clientMessageId || randomUUID();

  try {
    const message = await Message.create({
      conversationId: conversationIdFor(senderId, receiverId),
      senderId,
      receiverId,
      text,
      image,
      clientMessageId: idempotencyKey,
    });
    await touchConversation(message);
    return { message, created: true };
  } catch (err) {
    if (err?.code === 11000 && clientMessageId) {
      const winner = await Message.findOne({ senderId, clientMessageId });
      if (winner) return { message: winner, created: false };
    }
    throw err;
  }
};

/** Cursor pagination: newest first, `before` is the _id of the oldest message already shown. */
export const listMessages = async ({ me, peerId, before, limit }) => {
  await assertPeer(me, peerId);
  const pageSize = Math.min(Math.max(Number.parseInt(limit, 10) || config.limits.pageSize, 1), 100);

  const filter = { conversationId: conversationIdFor(me, peerId) };
  if (before !== undefined) {
    if (!isValidObjectId(before)) throw badRequest('Invalid cursor');
    filter._id = { $lt: new mongoose.Types.ObjectId(String(before)) };
  }

  const page = await Message.find(filter).sort({ _id: -1 }).limit(pageSize + 1);
  const hasMore = page.length > pageSize;
  const messages = page.slice(0, pageSize).reverse(); // chronological for display
  return { messages, nextCursor: hasMore ? String(messages[0]._id) : null };
};

/** Marks everything `peerId` sent to `me` as read. Returns the ids that changed. */
export const markConversationRead = async ({ me, peerId }) => {
  await assertPeer(me, peerId);
  const filter = { senderId: peerId, receiverId: me, readAt: null };
  const unread = await Message.find(filter).select('_id');
  if (!unread.length) return { ids: [], readAt: null };
  const readAt = new Date();
  await Message.updateMany({ _id: { $in: unread.map((m) => m._id) }, readAt: null }, { $set: { readAt } });
  return { ids: unread.map((m) => String(m._id)), readAt };
};

/** Contacts list with last message and unread count per contact. */
export const listContacts = async ({ me }) => {
  const meId = new mongoose.Types.ObjectId(String(me));
  const [users, conversations, unread] = await Promise.all([
    User.find({ _id: { $ne: meId } }).sort({ fullName: 1 }),
    Conversation.find({ participants: meId }).select('lastMessage'),
    Message.aggregate([
      { $match: { receiverId: meId, readAt: null } },
      { $group: { _id: '$senderId', count: { $sum: 1 } } },
    ]),
  ]);

  const lastByConversation = new Map(conversations.map((c) => [c._id, c.lastMessage]));
  const unreadBySender = new Map(unread.map((r) => [String(r._id), r.count]));

  return users
    .map((u) => {
      const last = lastByConversation.get(conversationIdFor(me, u._id));
      return {
        ...u.toPublic(),
        lastMessage: last?._id
          ? { _id: last._id, text: last.text ?? null, hasImage: Boolean(last.hasImage), senderId: last.senderId, createdAt: last.createdAt }
          : null,
        unreadCount: unreadBySender.get(String(u._id)) || 0,
      };
    })
    .sort((a, b) => {
      // Most recent conversation first, then alphabetical.
      const ta = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const tb = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
      return tb - ta || a.fullName.localeCompare(b.fullName);
    });
};
