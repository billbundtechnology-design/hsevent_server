import { z } from 'zod';

const commonFields = {
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(''),
  priceKobo: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  unit: z.string().trim().min(1).max(40),
  active: z.boolean().default(true),
  published: z.boolean().default(false),
  popular: z.boolean().default(false),
  sortOrder: z.number().int().min(-100000).max(100000).default(0),
  imageUrl: z.string().url().max(2048).nullable().optional(),
  imagePublicId: z.string().trim().min(1).max(255).nullable().optional(),
};

const venueFields = {
  capacity: z.number().int().min(1).max(100000).nullable().optional(),
  amenities: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  address: z.string().trim().max(500).nullable().optional(),
  bufferBeforeMinutes: z.number().int().min(0).max(10080).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(10080).default(0),
  status: z.enum(['available', 'maintenance', 'inactive']).default('available'),
};

const planningFields = {
  features: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
};

const imagePair = (
  input: { imageUrl?: string | null; imagePublicId?: string | null },
  ctx: z.RefinementCtx,
) => {
  const urlProvided = input.imageUrl !== undefined;
  const publicIdProvided = input.imagePublicId !== undefined;
  if (
    urlProvided !== publicIdProvided ||
    (urlProvided && Boolean(input.imageUrl) !== Boolean(input.imagePublicId))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['imagePublicId'],
      message: 'imageUrl and imagePublicId must be provided together.',
    });
  }
};

const createSchema = (kind: 'venue' | 'planning') =>
  z.object({
    ...commonFields,
    ...(kind === 'venue' ? venueFields : planningFields),
  }).superRefine(imagePair);

const updateSchema = (kind: 'venue' | 'planning') =>
  z.object({
    name: commonFields.name.optional(),
    category: commonFields.category.optional(),
    description: commonFields.description.optional(),
    priceKobo: commonFields.priceKobo.optional(),
    unit: commonFields.unit.optional(),
    active: commonFields.active.optional(),
    published: commonFields.published.optional(),
    popular: commonFields.popular.optional(),
    sortOrder: commonFields.sortOrder.optional(),
    imageUrl: commonFields.imageUrl,
    imagePublicId: commonFields.imagePublicId,
    ...(kind === 'venue'
      ? {
          capacity: venueFields.capacity,
          amenities: venueFields.amenities.optional(),
          address: venueFields.address,
          bufferBeforeMinutes: venueFields.bufferBeforeMinutes.optional(),
          bufferAfterMinutes: venueFields.bufferAfterMinutes.optional(),
          status: venueFields.status.optional(),
        }
      : { features: planningFields.features.optional() }),
    version: z.number().int().min(1),
  }).refine((input) => Object.keys(input).some((key) => key !== 'version'), {
    message: 'At least one catalogue field must be updated.',
  }).superRefine(imagePair);

export const venueCreateSchema = createSchema('venue');
export const venueUpdateSchema = updateSchema('venue');
export const serviceCreateSchema = createSchema('planning');
export const serviceUpdateSchema = updateSchema('planning');

export const listingCreateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('venue'), ...commonFields, ...venueFields }),
  z.object({ kind: z.literal('planning'), ...commonFields, ...planningFields }),
]).superRefine(imagePair);

export const listingUpdateSchema = z.object({
  name: commonFields.name.optional(),
  category: commonFields.category.optional(),
  description: commonFields.description.optional(),
  priceKobo: commonFields.priceKobo.optional(),
  unit: commonFields.unit.optional(),
  active: commonFields.active.optional(),
  published: commonFields.published.optional(),
  popular: commonFields.popular.optional(),
  sortOrder: commonFields.sortOrder.optional(),
  imageUrl: commonFields.imageUrl,
  imagePublicId: commonFields.imagePublicId,
  version: z.number().int().min(1),
}).refine((input) => Object.keys(input).some((key) => key !== 'version'), {
  message: 'At least one catalogue field must be updated.',
}).superRefine(imagePair);

export const catalogueListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(80).optional(),
  kind: z.enum(['rental', 'venue', 'planning']).optional(),
  active: z.coerce.boolean().optional(),
  status: z.enum(['available', 'maintenance', 'inactive', 'active', 'archived']).optional(),
  minCapacity: z.coerce.number().int().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'popular']).default('newest'),
});

export const publicListingListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(80).optional(),
  kind: z.enum(['rental', 'venue', 'planning']).optional(),
  guestCount: z.coerce.number().int().min(1).optional(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'popular']).default('newest'),
});

export const listingIdSchema = z.object({ id: z.string().uuid() });
export const blackoutIdSchema = z.object({ id: z.string().uuid(), blackoutId: z.string().uuid() });

export const blackoutCreateSchema = z.object({
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500),
}).refine((input) => new Date(input.endAt) > new Date(input.startAt), {
  path: ['endAt'],
  message: 'endAt must be after startAt.',
});

export const publicAvailabilitySchema = z.object({
  listingId: z.string().uuid(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  quantity: z.coerce.number().int().min(1).max(1000000).default(1),
  guestCount: z.coerce.number().int().min(1).max(100000).optional(),
}).refine((input) => new Date(input.endAt) > new Date(input.startAt), {
  path: ['endAt'],
  message: 'endAt must be after startAt.',
});

export const venueAvailabilitySchema = z.object({
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  quantity: z.coerce.number().int().min(1).max(1).default(1),
  guestCount: z.coerce.number().int().min(1).max(100000).optional(),
}).refine((input) => new Date(input.endAt) > new Date(input.startAt), {
  path: ['endAt'],
  message: 'endAt must be after startAt.',
});
