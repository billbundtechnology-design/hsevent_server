import { z } from 'zod';

const methodSchema = z.enum(['bank_transfer', 'pos', 'cash']);

export const paymentCreateSchema = z.object({
  amountKobo: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  method: methodSchema,
  externalReference: z.string().trim().min(1).max(160).optional(),
  recordedAt: z.string().datetime({ offset: true }).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const paymentListSchema = z.object({
  bookingId: z.string().uuid().optional(),
  status: z.enum(['succeeded', 'partially_refunded', 'refunded']).optional(),
  method: methodSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).refine((input) => !input.from || !input.to || new Date(input.to) >= new Date(input.from), {
  path: ['to'],
  message: 'to must be on or after from.',
});

export const paymentIdSchema = z.object({ paymentId: z.string().uuid() });

export const refundCreateSchema = z.object({
  amountKobo: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  method: methodSchema,
  externalReference: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().min(1).max(500),
  refundedAt: z.string().datetime({ offset: true }).optional(),
});
