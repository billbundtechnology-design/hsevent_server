import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const discountPercent = z.number().min(0).max(100).multipleOf(0.01);

export const publicEnquirySchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()).optional(),
  phone: z.string().trim().min(5).max(32).optional(),
  eventType: z.string().trim().max(120).optional(),
  eventDate: isoDate.optional(),
  guestCount: z.number().int().min(1).max(100000).optional(),
  message: z.string().trim().min(1).max(2000),
  source: z.string().trim().max(80).optional(),
  consent: z.boolean().optional(),
}).refine((input) => input.email || input.phone, {
  message: 'An email or phone number is required.',
  path: ['email'],
});

export const enquiryListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['new', 'contacted', 'qualified', 'converted', 'closed']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).refine((query) => !query.from || !query.to || query.to >= query.from, {
  path: ['to'],
  message: 'to must be on or after from.',
});

export const enquiryIdSchema = z.object({ id: z.string().uuid() });

export const updateEnquirySchema = z.object({
  status: z.enum(['new', 'contacted', 'qualified', 'closed']).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  internalNotes: z.string().trim().max(2000).nullable().optional(),
  version: z.number().int().min(1),
}).refine((input) => Object.keys(input).some((key) => key !== 'version'), {
  message: 'At least one enquiry field must be changed.',
});

export const convertEnquirySchema = z.object({
  eventName: z.string().trim().min(1).max(160),
  businessArm: z.enum(['rentals', 'planning', 'venue']),
  eventDate: isoDate,
  startAt: z.string().datetime({ offset: true }).optional(),
  endAt: z.string().datetime({ offset: true }).optional(),
  venueId: z.string().uuid().nullable().optional(),
  guestCount: z.number().int().min(1).max(100000).optional(),
  discountPercent: discountPercent.optional(),
  deliveryAddress: z.string().trim().max(500).optional(),
  items: z.array(z.object({
    listingId: z.string().uuid(),
    quantity: z.number().int().min(1).max(10000),
  })).max(100),
  notes: z.string().trim().max(2000).optional(),
}).superRefine((input, ctx) => {
  if (Boolean(input.startAt) !== Boolean(input.endAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endAt'], message: 'Both startAt and endAt are required together.' });
  }
  if (input.startAt && input.endAt && new Date(input.endAt) <= new Date(input.startAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endAt'], message: 'endAt must be after startAt.' });
  }
  if (input.businessArm === 'venue' && (!input.startAt || !input.endAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['startAt'], message: 'Venue bookings require startAt and endAt.' });
  }
  if (input.businessArm === 'venue' && !input.venueId && input.items.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['venueId'], message: 'Venue bookings require a venueId.' });
  }
  if (input.businessArm !== 'venue' && input.items.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'At least one booking item is required.' });
  }
  const listingIds = input.items.map(({ listingId }) => listingId);
  if (new Set(listingIds).size !== listingIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'Each listing may appear only once.' });
  }
});
