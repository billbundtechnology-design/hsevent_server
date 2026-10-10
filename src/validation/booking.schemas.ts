import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const intervalDateTime = z.string().datetime({ offset: true });
const discountPercent = z.number().min(0).max(100).multipleOf(0.01);
const customerDetailsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()).optional(),
  phone: z.string().trim().min(5).max(32).optional(),
}).refine((customer) => customer.email || customer.phone, {
  message: 'A customer email or phone number is required.',
});
const bookingFields = {
  customer: customerDetailsSchema.optional(),
  customerId: z.string().uuid().optional(),
  eventName: z.string().trim().min(1).max(160),
  businessArm: z.enum(['rentals', 'planning', 'venue']),
  eventDate: isoDate,
  startAt: intervalDateTime.optional(),
  endAt: intervalDateTime.optional(),
  venueId: z.string().uuid().nullable().optional(),
  guestCount: z.number().int().min(1).max(100000).optional(),
  deliveryAddress: z.string().trim().max(500).optional(),
  items: z.array(z.object({
    listingId: z.string().uuid(),
    quantity: z.number().int().min(1).max(10000),
  })).max(100),
  notes: z.string().trim().max(2000).optional(),
};

const validateBooking = (booking: {
  customer?: unknown;
  customerId?: string;
  businessArm: 'rentals' | 'planning' | 'venue';
  startAt?: string;
  endAt?: string;
  venueId?: string | null;
  guestCount?: number;
  items: Array<{ listingId: string; quantity: number }>;
}, ctx: z.RefinementCtx) => {
  if (!booking.customer && !booking.customerId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customer'], message: 'Customer details or customerId are required.' });
  }
  if (Boolean(booking.startAt) !== Boolean(booking.endAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endAt'], message: 'Both startAt and endAt are required together.' });
  }
  if (booking.startAt && booking.endAt && new Date(booking.endAt) <= new Date(booking.startAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endAt'], message: 'endAt must be after startAt.' });
  }
  if (booking.businessArm === 'venue' && (!booking.startAt || !booking.endAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['startAt'], message: 'Venue bookings require startAt and endAt.' });
  }
  if (booking.businessArm === 'venue' && !booking.venueId && booking.items.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['venueId'], message: 'Venue bookings require a venueId.' });
  }
  if (booking.businessArm !== 'venue' && booking.items.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'At least one booking item is required.' });
  }
  if (booking.venueId && !booking.guestCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['guestCount'], message: 'guestCount is required for venue bookings.' });
  }
};

export const createBookingSchema = z.object(bookingFields).superRefine(validateBooking);

export const publicBookingSchema = z.object({
  ...bookingFields,
  customer: customerDetailsSchema,
}).omit({ customerId: true }).superRefine(validateBooking);

const uniqueListingItems = <T extends { items: Array<{ listingId: string }> }>(
  schema: z.ZodType<T>,
) => schema.superRefine((booking, ctx) => {
  const seen = new Set<string>();
  booking.items.forEach((item, index) => {
    if (seen.has(item.listingId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'listingId'],
        message: 'Each listing may appear only once.',
      });
    }
    seen.add(item.listingId);
  });
});

export const adminCreateBookingSchema = uniqueListingItems(
  z.object({
    ...bookingFields,
    discountPercent: discountPercent.optional(),
  }).superRefine(validateBooking),
);
export const publicCreateBookingSchema = uniqueListingItems(publicBookingSchema);
export const updateBookingSchema = uniqueListingItems(
  z.object({
    ...bookingFields,
    discountPercent: discountPercent.optional(),
    version: z.number().int().min(1),
  }).superRefine(validateBooking),
);

export const bookingListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled']).optional(),
  businessArm: z.enum(['rentals', 'planning', 'venue']).optional(),
  customerId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  venueId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const bookingIdSchema = z.object({ id: z.string().uuid() });
export const cancelBookingSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().min(1),
  confirm: z.literal(true),
});

export const publicRequestStatusSchema = z.object({
  token: z.string().min(32).max(256),
});
