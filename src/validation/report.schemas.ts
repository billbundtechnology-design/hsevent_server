import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

const dateRange = {
  from: date.optional(),
  to: date.optional(),
};

const rangeRefinement = <T extends { from?: string; to?: string }>(schema: z.ZodType<T>) =>
  schema.refine((input) => !input.from || !input.to || input.to >= input.from, {
    path: ['to'],
    message: 'to must be on or after from.',
  });

export const reportSummarySchema = rangeRefinement(z.object(dateRange));

export const bookingReportSchema = rangeRefinement(z.object({
  ...dateRange,
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
}));

export const paymentReportSchema = rangeRefinement(z.object({
  ...dateRange,
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
}));

export const inventoryReportSchema = z.object({});

export const bookingExportSchema = rangeRefinement(z.object({
  ...dateRange,
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled']).optional(),
  businessArm: z.enum(['rentals', 'planning', 'venue']).optional(),
}));

export const paymentExportSchema = rangeRefinement(z.object({
  ...dateRange,
  method: z.enum(['bank_transfer', 'pos', 'cash']).optional(),
}));
