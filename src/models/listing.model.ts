import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const listingSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true, index: true },
    businessId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    sku: { type: String, trim: true, uppercase: true, maxlength: 64, default: null },
    kind: { type: String, enum: ['rental', 'venue', 'planning'], required: true },
    category: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    priceKobo: { type: Number, required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
    unit: { type: String, required: true, trim: true, maxlength: 40 },
    active: { type: Boolean, default: true },
    published: { type: Boolean, default: false },
    totalUnits: { type: Number, min: 0, default: null },
    damagedUnits: { type: Number, min: 0, default: 0 },
    missingUnits: { type: Number, min: 0, default: 0 },
    capacity: { type: Number, min: 1, default: null },
    status: { type: String, enum: ['available', 'maintenance', 'inactive'], default: 'available' },
    amenities: { type: [String], default: [] },
    features: { type: [String], default: [] },
    address: { type: String, trim: true, maxlength: 500, default: null },
    bufferBeforeMinutes: { type: Number, min: 0, default: 0 },
    bufferAfterMinutes: { type: Number, min: 0, default: 0 },
    popular: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
    allocationVersion: { type: Number, default: 0 },
    version: { type: Number, default: 1 },
    imageUrl: { type: String, default: null },
    imagePublicId: { type: String, default: null },
  },
  { timestamps: true },
);

listingSchema.index({ businessId: 1, active: 1, published: 1, kind: 1 });
listingSchema.index({ businessId: 1, active: 1, published: 1, category: 1, kind: 1 });
listingSchema.index({ businessId: 1, kind: 1, createdAt: -1 });
listingSchema.index({ businessId: 1, kind: 1, priceKobo: 1 });
listingSchema.index({ businessId: 1, kind: 1, popular: -1, sortOrder: 1 });
listingSchema.index(
  { businessId: 1, sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $type: 'string' } } },
);

export const Listing = model('Listing', listingSchema);
