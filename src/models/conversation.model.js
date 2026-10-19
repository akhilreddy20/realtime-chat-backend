import mongoose from 'mongoose';

/**
 * One document per 1:1 conversation, holding a denormalized copy of the
 * latest message. The contacts list reads these instead of scanning every
 * message the user has ever sent or received.
 */
const conversationSchema = new mongoose.Schema(
  {
    _id: { type: String }, // conversationIdFor(a, b)
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
    lastMessage: {
      _id: mongoose.Schema.Types.ObjectId,
      senderId: mongoose.Schema.Types.ObjectId,
      text: String,
      hasImage: Boolean,
      createdAt: Date,
    },
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1 });

export const Conversation = mongoose.model('Conversation', conversationSchema);
export default Conversation;
