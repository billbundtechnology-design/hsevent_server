import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const userSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    active: { type: Boolean, default: true },
    authVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const User = model('User', userSchema);
