import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const businessSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: String, trim: true, maxlength: 500, default: null },
    currency: { type: String, default: 'NGN', enum: ['NGN'] },
    timezone: { type: String, default: 'Africa/Lagos' },
    bookingPolicies: {
      depositPercent: { type: Number, min: 0, max: 100, default: 0 },
      taxPercent: { type: Number, min: 0, max: 100, default: 0 },
      cancellationCutoffHours: { type: Number, min: 0, max: 8760, default: 0 },
      refundPercentBeforeCutoff: { type: Number, min: 0, max: 100, default: 100 },
      refundPercentAfterCutoff: { type: Number, min: 0, max: 100, default: 0 },
    },
    notifications: {
      bookingRequests: { type: Boolean, default: true },
      payments: { type: Boolean, default: true },
      dispatch: { type: Boolean, default: true },
      returns: { type: Boolean, default: true },
    },
    invoiceBranding: {
      displayName: { type: String, trim: true, maxlength: 120, default: null },
      footer: { type: String, trim: true, maxlength: 1000, default: null },
    },
  },
  { timestamps: true },
);

export const Business = model('Business', businessSchema);
