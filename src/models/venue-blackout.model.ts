import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const venueBlackoutSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true },
    businessId: { type: String, required: true, index: true },
    venueId: { type: String, required: true, index: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);

venueBlackoutSchema.index({ businessId: 1, venueId: 1, startAt: 1, endAt: 1 });

export const VenueBlackout = model('VenueBlackout', venueBlackoutSchema);
