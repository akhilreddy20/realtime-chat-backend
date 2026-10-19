import mongoose from 'mongoose';

/** Stable id for a 1:1 conversation, independent of who sent first. */
export const conversationIdFor = (a, b) => [String(a), String(b)].sort().join('_');

const messageSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, trim: true, maxlength: 2000 },
    image: { type: String },
    // Client-generated id: lets a client retry a send without creating duplicates.
    // The server fills in a random one when the client doesn't send it.
    clientMessageId: { type: String, required: true, maxlength: 64 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true } // (the original schema had `timeStamps`, so createdAt was never set)
);

// History pages: newest first within one conversation, cursor = _id.
messageSchema.index({ conversationId: 1, _id: -1 });
// Unread counts for the logged-in user.
messageSchema.index({ receiverId: 1, readAt: 1, senderId: 1 });
// Idempotent sends: one message per (sender, clientMessageId).
messageSchema.index({ senderId: 1, clientMessageId: 1 }, { unique: true });

export const Message = mongoose.model('Message', messageSchema);
export default Message;
