import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const dispatchOperationSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true },
    businessId: { type: String, required: true, index: true },
    dispatchId: { type: String, required: true, index: true },
    operation: { type: String, enum: ['created', 'checklist', 'dispatched', 'returned'], required: true },
    idempotencyKeyHash: { type: String, required: true },
    payloadHash: { type: String, required: true },
    result: { type: Schema.Types.Mixed, required: true },
    actorId: { type: String, required: true },
    requestId: { type: String, default: null },
  },
  { timestamps: true },
);

dispatchOperationSchema.index({ businessId: 1, idempotencyKeyHash: 1 }, { unique: true });

export const DispatchOperation = model('DispatchOperation', dispatchOperationSchema);
