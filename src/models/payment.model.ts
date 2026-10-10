import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const paymentSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true },
    reference: { type: String, required: true, unique: true },
    businessId: { type: String, required: true, index: true },
    bookingId: { type: String, required: true, index: true },
    amountKobo: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ['bank_transfer', 'pos', 'cash'], required: true },
    status: { type: String, enum: ['succeeded'], default: 'succeeded', required: true },
    externalReference: { type: String, trim: true, maxlength: 160, default: null },
    recordedAt: { type: Date, required: true },
    notes: { type: String, trim: true, maxlength: 1000, default: null },
    createdBy: { type: String, required: true },
    idempotencyKeyHash: { type: String, required: true, select: false },
    idempotencyPayloadHash: { type: String, required: true, select: false },
  },
  { timestamps: true },
);

paymentSchema.index({ businessId: 1, idempotencyKeyHash: 1 }, { unique: true });
paymentSchema.index(
  { businessId: 1, externalReference: 1 },
  { unique: true, partialFilterExpression: { externalReference: { $type: 'string' } } },
);
paymentSchema.index({ businessId: 1, bookingId: 1, recordedAt: -1 });

export const Payment = model('Payment', paymentSchema);
