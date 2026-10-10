import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const customerSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true, index: true },
    businessId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
    phone: { type: String, trim: true, maxlength: 32, default: null },
    type: { type: String, enum: ['private', 'corporate'], required: true },
    companyName: { type: String, trim: true, maxlength: 160, default: null },
    address: { type: String, trim: true, maxlength: 500, default: null },
    archivedAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true },
);

customerSchema.index({ businessId: 1, createdAt: -1 });
customerSchema.index({ businessId: 1, email: 1 });

export const Customer = model('Customer', customerSchema);
