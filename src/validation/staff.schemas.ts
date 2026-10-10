import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { staffRoles } from '../auth/permissions.js';
export type StaffRole = (typeof staffRoles)[number];

export const staffListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'invited', 'suspended']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const staffUpdateSchema = z.object({
  role: z.enum(staffRoles).optional(),
  status: z.enum(['active', 'suspended']).optional(),
}).refine((fields) => Object.keys(fields).length > 0, {
  message: 'At least one staff field must be changed.',
});

export const invitationCreateSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  role: z.enum(staffRoles),
});

export const invitationAcceptSchema = z.object({
  token: z.string().min(32).max(256),
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(12).max(128).refine((password) => !bcrypt.truncates(password)).optional(),
});

export const staffIdParamSchema = z.object({ id: z.string().uuid() });
export const invitationIdParamSchema = z.object({ id: z.string().uuid() });

export const invitationListSchema = z.object({
  status: z.enum(['pending', 'accepted', 'expired', 'revoked']).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
