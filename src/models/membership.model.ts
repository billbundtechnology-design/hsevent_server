import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';
import { roles } from '../auth/permissions.js';

const membershipSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    businessId: { type: String, required: true, index: true },
    role: { type: String, enum: roles, required: true },
    status: { type: String, enum: ['active', 'invited', 'suspended'], default: 'active' },
  },
  { timestamps: true },
);

membershipSchema.index({ userId: 1, businessId: 1 }, { unique: true });

export const Membership = model('Membership', membershipSchema);
