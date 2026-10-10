import type { RequestHandler } from 'express';
import { AppError } from '../middleware/http-error.js';
import {
  createDispatch,
  getDispatch,
  listDispatches,
  markDispatched,
  markReturned,
  recordChecklist,
  updateDispatch,
} from '../services/dispatch.service.js';
import {
  checklistSchema,
  dispatchCreateSchema,
  dispatchIdSchema,
  dispatchListSchema,
  dispatchUpdateSchema,
  dispatchedSchema,
  returnedSchema,
} from '../validation/dispatch.schemas.js';
import { parseOrThrow } from '../validation/parse.js';

const context = (request: Parameters<RequestHandler>[0]) => {
  if (!request.authContext) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return request.authContext;
};

const idempotencyKey = (request: Parameters<RequestHandler>[0]): string => {
  const key = request.get('idempotency-key')?.trim();
  if (!key || key.length < 16 || key.length > 128) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key header between 16 and 128 characters.');
  }
  return key;
};

const requestId = (request: Parameters<RequestHandler>[0]) => String(request.id);

export const listDispatchesController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const input = parseOrThrow(dispatchListSchema, request.query);
  response.json(await listDispatches(auth.businessId, input));
};

export const createDispatchController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id: bookingId } = parseOrThrow(dispatchIdSchema, request.params);
  const input = parseOrThrow(dispatchCreateSchema, request.body);
  const result = await createDispatch(
    auth.businessId,
    bookingId,
    auth.userId,
    requestId(request),
    idempotencyKey(request),
    input,
  );
  response.status(result.replayed ? 200 : 201).json({ data: result.data, replayed: result.replayed });
};

export const getDispatchController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id } = parseOrThrow(dispatchIdSchema, request.params);
  const data = await getDispatch(auth.businessId, id);
  response.setHeader('ETag', `W/"${data.version}"`);
  response.json({ data });
};

export const updateDispatchController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id } = parseOrThrow(dispatchIdSchema, request.params);
  const input = parseOrThrow(dispatchUpdateSchema, request.body);
  const data = await updateDispatch(auth.businessId, id, auth.userId, requestId(request), input);
  response.setHeader('ETag', `W/"${input.version + 1}"`);
  response.json({ data });
};

export const checklistController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id } = parseOrThrow(dispatchIdSchema, request.params);
  const input = parseOrThrow(checklistSchema, request.body);
  const result = await recordChecklist(
    auth.businessId,
    id,
    auth.userId,
    requestId(request),
    idempotencyKey(request),
    input,
  );
  response.json({ data: result.result, replayed: result.replayed });
};

export const markDispatchedController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id } = parseOrThrow(dispatchIdSchema, request.params);
  const input = parseOrThrow(dispatchedSchema, request.body);
  const result = await markDispatched(
    auth.businessId,
    id,
    auth.userId,
    requestId(request),
    idempotencyKey(request),
    input,
  );
  response.status(200).json({ data: result.result, replayed: result.replayed });
};

export const markReturnedController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id } = parseOrThrow(dispatchIdSchema, request.params);
  const input = parseOrThrow(returnedSchema, request.body);
  const result = await markReturned(
    auth.businessId,
    id,
    auth.userId,
    requestId(request),
    idempotencyKey(request),
    input,
  );
  response.status(200).json({ data: result.result, replayed: result.replayed });
};
