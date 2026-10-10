import type { RequestHandler } from 'express';
import { AppError } from '../middleware/http-error.js';
import {
  getRoleSettings,
  getSettings,
  updateBookingPolicies,
  updateBusinessProfile,
  updateInvoiceBranding,
  updateNotifications,
} from '../services/settings.service.js';
import {
  bookingPoliciesSchema,
  businessProfileSchema,
  invoiceBrandingSchema,
  notificationSettingsSchema,
} from '../validation/settings.schemas.js';
import { parseOrThrow } from '../validation/parse.js';

const context = (request: Parameters<RequestHandler>[0]) => {
  if (!request.authContext) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return request.authContext;
};

const requestId = (request: Parameters<RequestHandler>[0]) => String(request.id);

export const getSettingsController: RequestHandler = async (request, response) => {
  const auth = context(request);
  response.json({ data: await getSettings(auth.businessId) });
};

export const updateBusinessProfileController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const input = parseOrThrow(businessProfileSchema, request.body);
  response.json({
    data: await updateBusinessProfile(auth.businessId, auth.userId, requestId(request), input),
  });
};

export const updateBookingPoliciesController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const input = parseOrThrow(bookingPoliciesSchema, request.body);
  response.json({
    data: await updateBookingPolicies(auth.businessId, auth.userId, requestId(request), input),
  });
};

export const updateNotificationsController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const input = parseOrThrow(notificationSettingsSchema, request.body);
  response.json({
    data: await updateNotifications(auth.businessId, auth.userId, requestId(request), input),
  });
};

export const updateInvoiceBrandingController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const input = parseOrThrow(invoiceBrandingSchema, request.body);
  response.json({
    data: await updateInvoiceBranding(auth.businessId, auth.userId, requestId(request), input),
  });
};

export const getRoleSettingsController: RequestHandler = async (_request, response) => {
  response.json({ data: getRoleSettings() });
};
