import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const enquirySchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true, index: true },
    reference: { type: String, required: true, unique: true },
    businessId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
    phone: { type: String, trim: true, maxlength: 32, default: null },
    eventType: { type: String, trim: true, maxlength: 120, default: null },
    eventDate: { type: String, default: null },
    guestCount: { type: Number, min: 1, default: null },
    message: { type: String, trim: true, required: true, maxlength: 2000 },
    source: { type: String, trim: true, maxlength: 80, default: null },
    consentAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['new', 'contacted', 'qualified', 'converted', 'closed'],
      default: 'new',
      index: true,
    },
    assignedTo: { type: String, default: null },
    internalNotes: { type: String, trim: true, maxlength: 2000, default: null },
    bookingId: { type: String, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true },
);

enquirySchema.index({ businessId: 1, createdAt: -1 });
enquirySchema.index({ businessId: 1, eventDate: 1 });

export const Enquiry = model('Enquiry', enquirySchema);
