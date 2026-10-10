import { z } from 'zod';

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((value) => value || null);

export const customerCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()).optional(),
  phone: z.string().trim().min(5).max(32).optional(),
  type: z.enum(['private', 'corporate']),
  companyName: optionalText(160),
  address: optionalText(500),
}).refine(
  (customer) => customer.type !== 'corporate' || Boolean(customer.companyName),
  { path: ['companyName'], message: 'Company name is required for corporate customers.' },
);

export const customerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()).nullable().optional(),
  phone: z.string().trim().min(5).max(32).nullable().optional(),
  type: z.enum(['private', 'corporate']).optional(),
  companyName: z.string().trim().max(160).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  version: z.number().int().min(1),
}).refine(
  (fields) => Object.keys(fields).some((key) => key !== 'version'),
  { message: 'At least one customer field must be changed.' },
);

export const customerListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(['private', 'corporate']).optional(),
  archived: z.enum(['true', 'false']).default('false'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const idParamSchema = z.object({ id: z.string().uuid() });
export const customerBookingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
