import { z } from 'zod';

const dateTime = z.string().datetime({ offset: true });

export const dispatchListSchema = z.object({
  status: z.enum(['scheduled', 'preparing', 'dispatched', 'partially_returned', 'returned', 'cancelled', 'overdue']).optional(),
  from: dateTime.optional(),
  to: dateTime.optional(),
  bookingId: z.string().uuid().optional(),
  assignedStaffId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).refine((input) => !input.from || !input.to || new Date(input.to) >= new Date(input.from), {
  path: ['to'],
  message: 'to must be on or after from.',
});

export const dispatchCreateSchema = z.object({
  scheduledAt: dateTime.optional(),
  expectedReturnAt: dateTime.optional(),
  deliveryAddress: z.string().trim().max(500).nullable().optional(),
  assignedStaffIds: z.array(z.string().uuid()).max(50).default([]),
  internalNotes: z.string().trim().max(2000).nullable().optional(),
}).refine((input) => {
  if (!input.scheduledAt || !input.expectedReturnAt) return true;
  return new Date(input.expectedReturnAt) > new Date(input.scheduledAt);
}, { path: ['expectedReturnAt'], message: 'expectedReturnAt must be after scheduledAt.' });

export const dispatchUpdateSchema = z.object({
  scheduledAt: dateTime.optional(),
  expectedReturnAt: dateTime.optional(),
  deliveryAddress: z.string().trim().max(500).nullable().optional(),
  assignedStaffIds: z.array(z.string().uuid()).max(50).optional(),
  internalNotes: z.string().trim().max(2000).nullable().optional(),
  version: z.number().int().min(1),
}).refine((input) => Object.keys(input).some((key) => key !== 'version'), {
  message: 'At least one dispatch field must be updated.',
}).refine((input) => {
  if (!input.scheduledAt || !input.expectedReturnAt) return true;
  return new Date(input.expectedReturnAt) > new Date(input.scheduledAt);
}, { path: ['expectedReturnAt'], message: 'expectedReturnAt must be after scheduledAt.' });

export const checklistSchema = z.object({
  stage: z.enum(['preparation', 'dispatch', 'collection', 'return']),
  itemKey: z.string().trim().min(1).max(120),
  checked: z.boolean(),
  note: z.string().trim().max(500).optional(),
});

export const dispatchedSchema = z.object({
  dispatchedAt: dateTime.optional(),
  items: z.array(z.object({
    listingId: z.string().uuid(),
    quantity: z.number().int().min(1).max(1000000),
  })).min(1).max(100),
}).superRefine((input, ctx) => {
  const seen = new Set<string>();
  input.items.forEach((item, index) => {
    if (seen.has(item.listingId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'listingId'], message: 'Each dispatch item may appear only once.' });
    }
    seen.add(item.listingId);
  });
});

export const returnedSchema = z.object({
  returnedAt: dateTime.optional(),
  items: z.array(z.object({
    listingId: z.string().uuid(),
    returnedQuantity: z.number().int().min(0).max(1000000),
    damagedQuantity: z.number().int().min(0).max(1000000),
    missingQuantity: z.number().int().min(0).max(1000000),
  })).min(1).max(100),
}).superRefine((input, ctx) => {
  const seen = new Set<string>();
  input.items.forEach((item, index) => {
    if (seen.has(item.listingId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'listingId'], message: 'Each dispatch item may appear only once.' });
    }
    seen.add(item.listingId);
    if (item.damagedQuantity > item.returnedQuantity) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'damagedQuantity'], message: 'Damaged quantity cannot exceed returned quantity.' });
    }
  });
  if (input.items.every((item) =>
    item.returnedQuantity === 0 && item.damagedQuantity === 0 && item.missingQuantity === 0,
  )) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'At least one returned or missing quantity must be recorded.' });
  }
});

export const dispatchIdSchema = z.object({ id: z.string().uuid() });
