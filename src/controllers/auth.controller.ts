import type { RequestHandler } from 'express';
import type { LoginRequest } from '../validation/auth.schemas.js';
import { getCurrentUser, login } from '../services/auth.service.js';
import { AppError } from '../middleware/http-error.js';

export const loginUser: RequestHandler<Record<string, string>, unknown, LoginRequest> = async (
  request,
  response,
) => {
  const result = await login(request.body);
  response.json({
    data: {
      user: result.user,
      business: result.business,
      role: result.role,
      permissions: result.permissions,
      accessToken: result.accessToken,
      tokenType: result.tokenType,
      expiresAt: result.expiresAt,
    },
  });
};

export const getMe: RequestHandler = async (request, response) => {
  const context = request.authContext;
  if (!context) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }

  response.json({ data: await getCurrentUser(context) });
};
