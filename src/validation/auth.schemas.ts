import bcrypt from 'bcryptjs';
import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z
    .string()
    .min(1)
    .max(128)
    .refine((password) => !bcrypt.truncates(password)),
  businessId: z.string().uuid().optional(),
});

export type LoginRequest = z.infer<typeof loginSchema>;
