import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const bookingLineSchema = new Schema(
  {
    id: { type: String, default: randomUUID },
    listingId: { type: String, required: true },
    nameSnapshot: { type: String, required: true },
    kind: { type: String, enum: ['rental', 'venue', 'planning'], required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPriceKobo: { type: Number, required: true, min: 0 },
    lineTotalKobo: { type: Number, required: true, min: 0 },
    rentalPeriods: { type: Number, default: 1, min: 1 },
    rentalStartAt: { type: Date, default: null },
    rentalEndAt: { type: Date, default: null },
  },
  { _id: false },
);

const bookingSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true, index: true },
    reference: { type: String, required: true, unique: true },
    businessId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    customerSnapshot: {
      name: { type: String, required: true },
      email: { type: String, default: null },
      phone: { type: String, default: null },
    },
    eventName: { type: String, required: true, trim: true, maxlength: 160 },
    businessArm: { type: String, enum: ['rentals', 'planning', 'venue'], required: true },
    eventDate: { type: String, required: true },
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    venueId: { type: String, default: null },
    guestCount: { type: Number, min: 1, default: null },
    deliveryAddress: { type: String, trim: true, maxlength: 500, default: null },
    status: { type: String, enum: ['pending', 'confirmed', 'completed', 'cancelled'], default: 'pending', index: true },
    paymentStatus: { type: String, enum: ['unpaid', 'part_paid', 'paid'], default: 'unpaid' },
    currency: { type: String, enum: ['NGN'], default: 'NGN' },
    lines: { type: [bookingLineSchema], required: true },
    subtotalKobo: { type: Number, required: true, min: 0 },
    discountKobo: { type: Number, default: 0, min: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    taxKobo: { type: Number, default: 0, min: 0 },
    taxPercent: { type: Number, default: 0, min: 0, max: 100 },
    totalKobo: { type: Number, required: true, min: 0 },
    requiredDepositKobo: { type: Number, default: 0, min: 0 },
    paidKobo: { type: Number, default: 0, min: 0 },
    balanceKobo: { type: Number, required: true, min: 0 },
    notes: { type: String, trim: true, maxlength: 2000, default: null },
    cancellationReason: { type: String, trim: true, maxlength: 500, default: null },
    customerAccessTokenHash: { type: String, default: null, select: false },
    idempotencyKeyHash: { type: String, default: null, select: false },
    idempotencyPayloadHash: { type: String, default: null, select: false },
    createdBy: { type: String, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true },
);

bookingSchema.index({ businessId: 1, createdAt: -1 });
bookingSchema.index({ businessId: 1, eventDate: 1 });
bookingSchema.index(
  { businessId: 1, idempotencyKeyHash: 1 },
  { unique: true, partialFilterExpression: { idempotencyKeyHash: { $type: 'string' } } },
);

export const Booking = model('Booking', bookingSchema);
