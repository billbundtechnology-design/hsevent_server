import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

const auditEventSchema = new Schema(
  {
    id: { type: String, default: randomUUID, unique: true },
    businessId: { type: String, required: true, index: true },
    actorId: { type: String, default: null },
    resourceType: { type: String, required: true },
    resourceId: { type: String, required: true },
    action: { type: String, required: true },
    requestId: { type: String, default: null },
    details: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

auditEventSchema.index({ businessId: 1, resourceType: 1, resourceId: 1, createdAt: -1 });

export const AuditEvent = model('AuditEvent', auditEventSchema);
