import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const notificationOutboxSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true },
    dedupeKey: { type: String, required: true, unique: true },
    businessId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: ['booking.created', 'booking.updated', 'booking.confirmed', 'booking.cancelled', 'booking.completed'],
      required: true,
    },
    recipient: {
      name: { type: String, required: true },
      email: { type: String, default: null },
      phone: { type: String, default: null },
    },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['queued', 'processing', 'sent', 'failed'],
      default: 'queued',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    leaseUntil: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 1000 },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationOutboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

export const NotificationOutbox = model('NotificationOutbox', notificationOutboxSchema);
