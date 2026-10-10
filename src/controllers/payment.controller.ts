import type { RequestHandler } from 'express';
import { AppError } from '../middleware/http-error.js';
import {
  getPayment,
  listPayments,
  recordPayment,
  recordRefund,
} from '../services/payment.service.js';
import {
  paymentCreateSchema,
  paymentIdSchema,
  paymentListSchema,
  refundCreateSchema,
} from '../validation/payment.schemas.js';
import { parseOrThrow } from '../validation/parse.js';

const context = (request: Parameters<RequestHandler>[0]) => {
  if (!request.authContext) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return request.authContext;
};

const getIdempotencyKey = (request: Parameters<RequestHandler>[0]): string => {
  const key = request.get('idempotency-key')?.trim();
  if (!key || key.length < 16 || key.length > 128) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key header between 16 and 128 characters.');
  }
  return key;
};

export const listPaymentsController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const input = parseOrThrow(paymentListSchema, request.query);
  response.json(await listPayments(auth.businessId, input));
};

export const getPaymentController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { paymentId } = parseOrThrow(paymentIdSchema, { paymentId: request.params.paymentId });
  response.json({ data: await getPayment(auth.businessId, paymentId) });
};

export const recordPaymentController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { paymentId: bookingId } = parseOrThrow(paymentIdSchema, { paymentId: request.params.id });
  const input = parseOrThrow(paymentCreateSchema, request.body);
  const result = await recordPayment(
    auth.businessId,
    bookingId,
    auth.userId,
    String(request.id),
    getIdempotencyKey(request),
    input,
  );
  response.status(result.replayed ? 200 : 201).json({ data: result.payment, replayed: result.replayed });
};

export const createRefundController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { paymentId } = parseOrThrow(paymentIdSchema, { paymentId: request.params.paymentId });
  const input = parseOrThrow(refundCreateSchema, request.body);
  const result = await recordRefund(
    auth.businessId,
    paymentId,
    auth.userId,
    String(request.id),
    getIdempotencyKey(request),
    input,
  );
  response.status(result.replayed ? 200 : 201).json({ data: result.refund, replayed: result.replayed });
};
