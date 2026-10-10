import type { RequestHandler } from 'express';
import { AppError } from '../middleware/http-error.js';
import { hasSupportedImageSignature } from '../middleware/image-upload.middleware.js';
import {
  adjustStock,
  createInventoryItem,
  getInventoryAvailability,
  getInventoryItem,
  listInventory,
  reportCondition,
  uploadInventoryImageForBusiness,
  updateInventoryItem,
} from '../services/inventory.service.js';
import {
  conditionReportSchema,
  inventoryAvailabilitySchema,
  inventoryCreateSchema,
  inventoryIdSchema,
  inventoryListSchema,
  inventoryUpdateSchema,
  stockAdjustmentSchema,
} from '../validation/inventory.schemas.js';
import { parseOrThrow } from '../validation/parse.js';

const getContext = (request: Parameters<RequestHandler>[0]) => {
  const context = request.authContext;
  if (!context) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return context;
};

export const listInventoryController: RequestHandler = async (request, response) => {
  const context = getContext(request);
  const query = parseOrThrow(inventoryListSchema, request.query);
  response.json(await listInventory(context.businessId, query));
};

export const createInventoryController: RequestHandler = async (request, response) => {
  const context = getContext(request);
  const input = parseOrThrow(inventoryCreateSchema, request.body);
  const item = await createInventoryItem(
    context.businessId,
    context.userId,
    String(request.id),
    input,
  );
  response.setHeader('ETag', `W/"${item.version}"`);
  response.status(201).json({ data: item });
};

export const getInventoryController: RequestHandler = async (request, response) => {
  const context = getContext(request);
  const { id } = parseOrThrow(inventoryIdSchema, request.params);
  const item = await getInventoryItem(context.businessId, id);
  response.setHeader('ETag', `W/"${item.version}"`);
  response.json({ data: item });
};

export const updateInventoryController: RequestHandler = async (request, response) => {
  const context = getContext(request);
  const { id } = parseOrThrow(inventoryIdSchema, request.params);
  const input = parseOrThrow(inventoryUpdateSchema, request.body);
  const item = await updateInventoryItem(
    context.businessId,
    id,
    input,
    context.userId,
    String(request.id),
  );
  response.setHeader('ETag', `W/"${item.version}"`);
  response.json({ data: item });
};

export const adjustStockController: RequestHandler = async (request, response) => {
  const context = getContext(request);
  const { id } = parseOrThrow(inventoryIdSchema, request.params);
  const input = parseOrThrow(stockAdjustmentSchema, request.body);
  const item = await adjustStock(
    context.businessId,
    id,
    input,
    context.userId,
    String(request.id),
  );
  response.setHeader('ETag', `W/"${item.version}"`);
  response.json({ data: item });
};

export const reportConditionController: RequestHandler = async (request, response) => {
  const context = getContext(request);
  const { id } = parseOrThrow(inventoryIdSchema, request.params);
  const input = parseOrThrow(conditionReportSchema, request.body);
  const item = await reportCondition(
    context.businessId,
    id,
    input,
    context.userId,
    String(request.id),
  );
  response.setHeader('ETag', `W/"${item.version}"`);
  response.json({ data: item });
};

export const getInventoryAvailabilityController: RequestHandler = async (request, response) => {
  const context = getContext(request);
  const { id } = parseOrThrow(inventoryIdSchema, request.params);
  const query = parseOrThrow(inventoryAvailabilitySchema, request.query);
  response.json({ data: await getInventoryAvailability(context.businessId, id, query) });
};

export const uploadInventoryImageController: RequestHandler = async (request, response) => {
  const context = getContext(request);
  const file = request.file;
  if (!file) throw new AppError(422, 'IMAGE_REQUIRED', 'Attach an image using the "image" form field.');
  if (!hasSupportedImageSignature(file)) {
    throw new AppError(422, 'INVALID_IMAGE_TYPE', 'The file content is not a valid JPEG, PNG, or WebP image.');
  }

  const uploaded = await uploadInventoryImageForBusiness(
    context.businessId,
    context.userId,
    file,
  );
  response.status(201).json({ data: uploaded });
};
