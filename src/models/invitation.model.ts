import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';
import { staffRoles } from '../auth/permissions.js';

const invitationSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true, index: true },
    businessId: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: staffRoles, required: true },
    tokenHash: { type: String, required: true, unique: true, select: false },
    requiresAccountSetup: { type: Boolean, required: true, default: false },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);

invitationSchema.index({ businessId: 1, email: 1, acceptedAt: 1 });

export const Invitation = model('Invitation', invitationSchema);
