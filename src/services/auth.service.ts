import bcrypt from 'bcryptjs';
import {
  getPermissionsForRole,
  type Permission,
  type Role,
} from '../auth/permissions.js';
import { signAccessToken } from '../auth/token.utils.js';
import { Business } from '../models/business.model.js';
import { Membership } from '../models/membership.model.js';
import { User } from '../models/user.model.js';
import type { RequestAuthContext } from '../auth/auth.types.js';
import { AppError } from '../middleware/http-error.js';

export interface LoginInput {
  email: string;
  password: string;
  businessId?: string;
}

export interface UserSummary {
  id: string;
  name: string;
  email: string;
}

export interface AuthenticatedUser {
  user: UserSummary;
  business: { id: string; name: string };
  role: Role;
  permissions: readonly Permission[];
}

export interface LoginResult extends AuthenticatedUser {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
}

const dummyPasswordHash = bcrypt.hash('rentos-invalid-login-placeholder', 12);

const invalidCredentials = (): AppError =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

const toUserSummary = (user: { id: string; name: string; email: string }): UserSummary => ({
  id: user.id,
  name: user.name,
  email: user.email,
});

export const login = async (input: LoginInput): Promise<LoginResult> => {
  const user = await User.findOne({ email: input.email }).select('+passwordHash +authVersion');
  const passwordMatches = await bcrypt.compare(
    input.password,
    user?.passwordHash ?? (await dummyPasswordHash),
  );
  if (!user || !user.active || !passwordMatches) {
    throw invalidCredentials();
  }

  const membershipQuery: Record<string, unknown> = {
    userId: user.id,
    status: 'active',
  };
  if (input.businessId) membershipQuery.businessId = input.businessId;
  const memberships = await Membership.find(membershipQuery).sort({ createdAt: 1 });

  if (memberships.length === 0) {
    throw invalidCredentials();
  }
  if (!input.businessId && memberships.length > 1) {
    throw new AppError(
      422,
      'BUSINESS_SELECTION_REQUIRED',
      'Select a business by providing its businessId.',
    );
  }

  const membership = memberships[0];
  if (!membership) throw invalidCredentials();

  const business = await Business.findOne({ id: membership.businessId });
  if (!business) throw invalidCredentials();

  const accessToken = await signAccessToken({
    userId: user.id,
    membershipId: membership.id,
    authVersion: user.authVersion,
  });

  user.lastLoginAt = new Date();
  await user.save();

  return {
    user: toUserSummary(user),
    business: { id: business.id, name: business.name },
    role: membership.role,
    permissions: getPermissionsForRole(membership.role),
    accessToken: accessToken.token,
    tokenType: 'Bearer',
    expiresAt: accessToken.expiresAt,
  };
};

export const getCurrentUser = async (
  context: RequestAuthContext,
): Promise<AuthenticatedUser> => {
  const [user, membership] = await Promise.all([
    User.findOne({ id: context.userId, active: true }),
    Membership.findOne({ id: context.membershipId, status: 'active' }),
  ]);
  if (!user || !membership || membership.userId !== context.userId) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }

  const business = await Business.findOne({ id: membership.businessId });
  if (!business) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }

  return {
    user: toUserSummary(user),
    business: { id: business.id, name: business.name },
    role: context.role,
    permissions: context.permissions,
  };
};
