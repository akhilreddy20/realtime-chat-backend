import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    fullName: { type: String, required: true, trim: true, maxlength: 60 },
    password: { type: String, required: true, select: false },
    profilePic: { type: String, default: '' },
    lastSeenAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.methods.toPublic = function toPublic() {
  return {
    _id: this._id,
    fullName: this.fullName,
    email: this.email,
    profilePic: this.profilePic,
    lastSeenAt: this.lastSeenAt ?? null,
  };
};

export const User = mongoose.model('User', userSchema);
export default User;
