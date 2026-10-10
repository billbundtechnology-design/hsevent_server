import { z } from 'zod';

const imageFields = {
  imageUrl: z.string().url().max(2048).nullable().optional(),
  imagePublicId: z.string().trim().min(1).max(255).nullable().optional(),
};

const validateImagePair = (
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

export const inventoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  sku: z.string().trim().min(1).max(64).transform((sku) => sku.toUpperCase()),
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(''),
  totalUnits: z.number().int().min(0).max(1000000),
  damagedUnits: z.number().int().min(0).default(0),
  missingUnits: z.number().int().min(0).default(0),
  rentalRateKobo: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  unit: z.string().trim().min(1).max(40).default('per_item'),
  active: z.boolean().default(true),
  published: z.boolean().default(false),
  ...imageFields,
}).superRefine((input, ctx) => {
  if (input.damagedUnits + input.missingUnits > input.totalUnits) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['damagedUnits'],
      message: 'Damaged and missing units cannot exceed total stock.',
    });
  }
  validateImagePair(input, ctx);
});

export const inventoryUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  sku: z.string().trim().min(1).max(64).transform((sku) => sku.toUpperCase()).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(2000).optional(),
  rentalRateKobo: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  unit: z.string().trim().min(1).max(40).optional(),
  active: z.boolean().optional(),
  published: z.boolean().optional(),
  version: z.number().int().min(1),
  ...imageFields,
}).refine((input) => Object.keys(input).some((key) => key !== 'version'), {
  message: 'At least one inventory field must be updated.',
}).superRefine(validateImagePair);

export const inventoryListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(80).optional(),
  availability: z.enum(['available', 'low', 'out_of_stock']).optional(),
  condition: z.enum(['normal', 'damaged', 'missing']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const stockAdjustmentSchema = z.object({
  quantityDelta: z.number().int().min(-1000000).max(1000000).refine((value) => value !== 0),
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().min(1),
});

export const conditionReportSchema = z.object({
  damagedDelta: z.number().int().min(-1000000).max(1000000).default(0),
  missingDelta: z.number().int().min(-1000000).max(1000000).default(0),
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().min(1),
}).refine((input) => input.damagedDelta !== 0 || input.missingDelta !== 0, {
  message: 'A damaged or missing quantity change is required.',
});

export const inventoryAvailabilitySchema = z.object({
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  quantity: z.coerce.number().int().min(1).max(1000000).default(1),
}).refine((input) => new Date(input.endAt) > new Date(input.startAt), {
  path: ['endAt'],
  message: 'endAt must be after startAt.',
});

export const inventoryIdSchema = z.object({ id: z.string().uuid() });
