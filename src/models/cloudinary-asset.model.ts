import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const cloudinaryAssetSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true },
    businessId: { type: String, required: true, index: true },
    uploadedBy: { type: String, required: true },
    publicId: { type: String, required: true, unique: true },
    secureUrl: { type: String, required: true },
    resourceType: { type: String, enum: ['image'], required: true, default: 'image' },
    format: { type: String, required: true },
    bytes: { type: Number, required: true },
    attachedToListingId: { type: String, default: null },
  },
  { timestamps: true },
);

export const CloudinaryAsset = model('CloudinaryAsset', cloudinaryAssetSchema);
