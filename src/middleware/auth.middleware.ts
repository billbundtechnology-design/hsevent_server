import type { NextFunction, Request, Response } from 'express';
import { getPermissionsForRole, type Permission } from '../auth/permissions.js';
import { verifyAccessToken } from '../auth/token.utils.js';
import { Membership } from '../models/membership.model.js';
import { User } from '../models/user.model.js';
import { AppError } from './http-error.js';

export const authenticate = async (
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> => {
  const authorization = request.get('authorization');
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1]) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }

  let claims;
  try {
    claims = await verifyAccessToken(match[1]);
  } catch {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }

  const [user, membership] = await Promise.all([
    User.findOne({ id: claims.userId, active: true }).select('+authVersion'),
    Membership.findOne({
      id: claims.membershipId,
      userId: claims.userId,
      status: 'active',
    }),
  ]);

  if (!user || !membership || user.authVersion !== claims.authVersion) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }

  request.authContext = {
    userId: user.id,
    membershipId: membership.id,
    businessId: membership.businessId,
    role: membership.role,
    permissions: getPermissionsForRole(membership.role),
  };
  next();
};

export const requirePermission =
  (permission: Permission) =>
  (request: Request, _response: Response, next: NextFunction): void => {
    if (!request.authContext) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    }
    if (!request.authContext.permissions.includes(permission)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
    }
    next();
  };
