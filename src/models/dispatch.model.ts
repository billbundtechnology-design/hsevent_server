import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const dispatchItemSchema = new Schema(
  {
    listingId: { type: String, required: true },
    bookingLineId: { type: String, required: true },
    nameSnapshot: { type: String, required: true },
    expectedQuantity: { type: Number, required: true, min: 1 },
    dispatchedQuantity: { type: Number, default: 0, min: 0 },
    returnedQuantity: { type: Number, default: 0, min: 0 },
    damagedQuantity: { type: Number, default: 0, min: 0 },
    missingQuantity: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const checklistItemSchema = new Schema(
  {
    id: { type: String, default: randomUUID },
    stage: { type: String, enum: ['preparation', 'dispatch', 'collection', 'return'], required: true },
    itemKey: { type: String, required: true, trim: true, maxlength: 120 },
    checked: { type: Boolean, required: true },
    note: { type: String, trim: true, maxlength: 500, default: null },
    checkedBy: { type: String, required: true },
    checkedAt: { type: Date, required: true },
  },
  { _id: false },
);

const dispatchSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true },
    businessId: { type: String, required: true, index: true },
    bookingId: { type: String, required: true, index: true },
    reference: { type: String, required: true, unique: true },
    scheduledAt: { type: Date, required: true },
    expectedReturnAt: { type: Date, required: true },
    deliveryAddress: { type: String, trim: true, maxlength: 500, default: null },
    assignedStaffIds: { type: [String], default: [] },
    internalNotes: { type: String, trim: true, maxlength: 2000, default: null },
    status: {
      type: String,
      enum: ['scheduled', 'preparing', 'dispatched', 'partially_returned', 'returned', 'cancelled'],
      default: 'scheduled',
      index: true,
    },
    items: { type: [dispatchItemSchema], required: true },
    checklist: { type: [checklistItemSchema], default: [] },
    dispatchedAt: { type: Date, default: null },
    returnedAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);

dispatchSchema.index({ businessId: 1, bookingId: 1 }, { unique: true });
dispatchSchema.index({ businessId: 1, status: 1, scheduledAt: 1 });
dispatchSchema.index({ businessId: 1, assignedStaffIds: 1, status: 1 });

export const Dispatch = model('Dispatch', dispatchSchema);
