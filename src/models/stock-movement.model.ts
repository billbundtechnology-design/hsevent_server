import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const stockMovementSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true },
    businessId: { type: String, required: true, index: true },
    listingId: { type: String, required: true, index: true },
    actorId: { type: String, required: true },
    requestId: { type: String, default: null },
    type: { type: String, enum: ['stock_adjustment', 'condition_report', 'dispatch_return'], required: true },
    quantityDelta: { type: Number, default: 0 },
    damagedDelta: { type: Number, default: 0 },
    missingDelta: { type: Number, default: 0 },
    totalUnitsAfter: { type: Number, required: true },
    damagedUnitsAfter: { type: Number, required: true },
    missingUnitsAfter: { type: Number, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

stockMovementSchema.index({ businessId: 1, listingId: 1, createdAt: -1 });

export const StockMovement = model('StockMovement', stockMovementSchema);
