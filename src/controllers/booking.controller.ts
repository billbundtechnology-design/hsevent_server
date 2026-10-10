import type { RequestHandler } from 'express';
import { AppError } from '../middleware/http-error.js';
import {
  cancelBooking,
  completeBooking,
  confirmBooking,
  createAdminBooking,
  createPublicBookingRequest,
  getBookingCancellationPreview,
  getBooking,
  getPublicBookingRequest,
  listBookings,
  updatePendingBooking,
} from '../services/booking.service.js';
import {
  adminCreateBookingSchema,
  bookingIdSchema,
  bookingListSchema,
  cancelBookingSchema,
  publicCreateBookingSchema,
  publicRequestStatusSchema,
  updateBookingSchema,
} from '../validation/booking.schemas.js';
import { parseOrThrow } from '../validation/parse.js';

const getAuthContext = (request: Parameters<RequestHandler>[0]) => {
  const context = request.authContext;
  if (!context) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return context;
};

const requireIdempotencyKey = (request: Parameters<RequestHandler>[0]): string => {
  const key = request.get('idempotency-key')?.trim();
  if (!key || key.length < 16 || key.length > 128) {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Provide an Idempotency-Key header between 16 and 128 characters.',
    );
  }
  return key;
};

export const createPublicBookingController: RequestHandler = async (request, response) => {
  const input = parseOrThrow(publicCreateBookingSchema, request.body);
  const result = await createPublicBookingRequest(
    input,
    requireIdempotencyKey(request),
    String(request.id),
  );
  response.status(result.replayed ? 200 : 201).json({
    data: {
      requestId: result.requestId,
      reference: result.reference,
      status: result.status,
      totalKobo: result.totalKobo,
      requiredDepositKobo: result.requiredDepositKobo,
      currency: result.currency,
      accessToken: result.accessToken,
      notification: { status: result.notificationQueued ? 'enqueued' : 'suppressed' },
    },
  });
};

export const getPublicBookingRequestController: RequestHandler = async (request, response) => {
  const { id } = parseOrThrow(bookingIdSchema, request.params);
  const { token } = parseOrThrow(publicRequestStatusSchema, {
    token: request.get('x-booking-access-token'),
  });
  response.json({ data: await getPublicBookingRequest(id, token) });
};

export const listBookingsController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const query = parseOrThrow(bookingListSchema, request.query);
  response.json(await listBookings(context.businessId, query));
};

export const createBookingController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const input = parseOrThrow(adminCreateBookingSchema, request.body);
  const result = await createAdminBooking(
    context,
    input,
    requireIdempotencyKey(request),
    String(request.id),
  );
  response.status(result.replayed ? 200 : 201).json({ data: result.booking });
};

export const getBookingController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const { id } = parseOrThrow(bookingIdSchema, request.params);
  const booking = await getBooking(context.businessId, id);
  response.setHeader('ETag', `W/"${booking.version}"`);
  response.json({ data: booking });
};

export const updateBookingController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const { id } = parseOrThrow(bookingIdSchema, request.params);
  const input = parseOrThrow(updateBookingSchema, request.body);
  const booking = await updatePendingBooking(
    context.businessId,
    id,
    input,
    context.userId,
    String(request.id),
  );
  response.setHeader('ETag', `W/"${booking.version}"`);
  response.json({ data: booking });
};

export const confirmBookingController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const { id } = parseOrThrow(bookingIdSchema, request.params);
  response.json({
    data: await confirmBooking(context.businessId, id, context.userId, String(request.id)),
  });
};

export const cancelBookingController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const { id } = parseOrThrow(bookingIdSchema, request.params);
  const { reason, version } = parseOrThrow(cancelBookingSchema, request.body);
  response.json({
    data: await cancelBooking(
      context.businessId,
      id,
      reason,
      version,
      context.userId,
      String(request.id),
    ),
  });
};

export const bookingCancellationPreviewController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const { id } = parseOrThrow(bookingIdSchema, request.params);
  response.json({ data: await getBookingCancellationPreview(context.businessId, id) });
};

export const completeBookingController: RequestHandler = async (request, response) => {
  const context = getAuthContext(request);
  const { id } = parseOrThrow(bookingIdSchema, request.params);
  response.json({
    data: await completeBooking(context.businessId, id, context.userId, String(request.id)),
  });
};
