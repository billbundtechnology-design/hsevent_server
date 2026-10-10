import { z } from 'zod';

const percent = z.number().min(0).max(100).multipleOf(0.01);

export const businessProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().max(500).nullable().optional(),
  currency: z.literal('NGN').optional(),
  timezone: z.literal('Africa/Lagos').optional(),
}).refine((input) => Object.keys(input).length > 0, {
  message: 'At least one business profile field must be updated.',
});

export const bookingPoliciesSchema = z.object({
  depositPercent: percent.optional(),
  taxPercent: percent.optional(),
  cancellationCutoffHours: z.number().int().min(0).max(8760).optional(),
  refundPercentBeforeCutoff: percent.optional(),
  refundPercentAfterCutoff: percent.optional(),
}).refine((input) => Object.keys(input).length > 0, {
  message: 'At least one booking policy must be updated.',
});

export const notificationSettingsSchema = z.object({
  bookingRequests: z.boolean().optional(),
  payments: z.boolean().optional(),
  dispatch: z.boolean().optional(),
  returns: z.boolean().optional(),
}).refine((input) => Object.keys(input).length > 0, {
  message: 'At least one notification preference must be updated.',
});

export const invoiceBrandingSchema = z.object({
  displayName: z.string().trim().max(120).nullable().optional(),
  footer: z.string().trim().max(1000).nullable().optional(),
}).refine((input) => Object.keys(input).length > 0, {
  message: 'At least one invoice branding field must be updated.',
});
