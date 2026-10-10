import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Business } from '../models/business.model.js';
import { Membership } from '../models/membership.model.js';
import { User } from '../models/user.model.js';
import { env } from '../config/env.js';

const bootstrapSchema = z.object({
  BOOTSTRAP_OWNER_NAME: z.string().trim().min(1).max(120),
  BOOTSTRAP_OWNER_EMAIL: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  BOOTSTRAP_OWNER_PASSWORD: z
    .string()
    .min(12)
    .max(128)
    .refine((password) => !bcrypt.truncates(password)),
  BOOTSTRAP_BUSINESS_NAME: z.string().trim().min(1).max(120),
});

const bootstrapOwner = async (): Promise<void> => {
  const parsed = bootstrapSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Set valid bootstrap owner details in the environment: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`,
    );
  }

  await mongoose.connect(env.MONGODB_URI);
  if (await User.exists({})) {
    throw new Error('Owner bootstrap is only available before the first user is created.');
  }

  const business = await Business.create({ name: parsed.data.BOOTSTRAP_BUSINESS_NAME });
  let userId: string | undefined;
  try {
    const user = await User.create({
      name: parsed.data.BOOTSTRAP_OWNER_NAME,
      email: parsed.data.BOOTSTRAP_OWNER_EMAIL,
      passwordHash: await bcrypt.hash(parsed.data.BOOTSTRAP_OWNER_PASSWORD, 12),
    });
    userId = user.id;
    await Membership.create({
      userId: user.id,
      businessId: business.id,
      role: 'owner',
      status: 'active',
    });
    console.info(
      `Created the initial owner for business "${business.name}" (PUBLIC_BUSINESS_ID=${business.id}).`,
    );
  } catch (error) {
    if (userId) await User.deleteOne({ id: userId });
    await Business.deleteOne({ id: business.id });
    throw error;
  }
};

bootstrapOwner()
  .catch((error: unknown) => {
    console.error('Owner bootstrap failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
