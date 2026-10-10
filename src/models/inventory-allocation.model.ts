import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const allocationSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true },
    businessId: { type: String, required: true, index: true },
    bookingId: { type: String, required: true, index: true },
    listingId: { type: String, required: true, index: true },
    quantity: { type: Number, required: true, min: 1 },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    status: { type: String, enum: ['active', 'released'], default: 'active', index: true },
  },
  { timestamps: true },
);

allocationSchema.index({ businessId: 1, listingId: 1, status: 1, startAt: 1, endAt: 1 });

export const InventoryAllocation = model('InventoryAllocation', allocationSchema);
