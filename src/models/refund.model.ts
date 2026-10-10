import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const refundSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true },
    reference: { type: String, required: true, unique: true },
    businessId: { type: String, required: true, index: true },
    paymentId: { type: String, required: true, index: true },
    bookingId: { type: String, required: true, index: true },
    amountKobo: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ['bank_transfer', 'pos', 'cash'], required: true },
    status: { type: String, enum: ['succeeded'], default: 'succeeded', required: true },
    externalReference: { type: String, trim: true, maxlength: 160, default: null },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    refundedAt: { type: Date, required: true },
    createdBy: { type: String, required: true },
    idempotencyKeyHash: { type: String, required: true, select: false },
    idempotencyPayloadHash: { type: String, required: true, select: false },
  },
  { timestamps: true },
);

refundSchema.index({ businessId: 1, idempotencyKeyHash: 1 }, { unique: true });
refundSchema.index(
  { businessId: 1, externalReference: 1 },
  { unique: true, partialFilterExpression: { externalReference: { $type: 'string' } } },
);
refundSchema.index({ businessId: 1, paymentId: 1, refundedAt: -1 });

export const Refund = model('Refund', refundSchema);
