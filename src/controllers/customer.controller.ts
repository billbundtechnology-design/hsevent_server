import type { RequestHandler } from 'express';
import { AppError } from '../middleware/http-error.js';
import {
  archiveCustomer,
  createCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from '../services/customer.service.js';
import { listCustomerBookings } from '../services/booking.service.js';
import {
  customerCreateSchema,
  customerBookingsQuerySchema,
  customerListSchema,
  customerUpdateSchema,
  idParamSchema,
} from '../validation/customer.schemas.js';
import { parseOrThrow } from '../validation/parse.js';

const getBusinessId = (request: Parameters<RequestHandler>[0]): string => {
  const businessId = request.authContext?.businessId;
  if (!businessId) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return businessId;
};

export const listCustomersController: RequestHandler = async (request, response) => {
  const query = parseOrThrow(customerListSchema, request.query);
  response.json(await listCustomers(getBusinessId(request), query));
};

export const createCustomerController: RequestHandler = async (request, response) => {
  const input = parseOrThrow(customerCreateSchema, request.body);
  const customer = await createCustomer(getBusinessId(request), input);
  response.status(201).json({ data: customer });
};

export const getCustomerController: RequestHandler = async (request, response) => {
  const { id } = parseOrThrow(idParamSchema, request.params);
  const customer = await getCustomer(getBusinessId(request), id);
  response.setHeader('ETag', `W/"${customer.version}"`);
  response.json({ data: customer });
};

export const updateCustomerController: RequestHandler = async (request, response) => {
  const { id } = parseOrThrow(idParamSchema, request.params);
  const input = parseOrThrow(customerUpdateSchema, request.body);
  const customer = await updateCustomer(getBusinessId(request), id, input);
  response.setHeader('ETag', `W/"${customer.version}"`);
  response.json({ data: customer });
};

export const archiveCustomerController: RequestHandler = async (request, response) => {
  const { id } = parseOrThrow(idParamSchema, request.params);
  const customer = await archiveCustomer(getBusinessId(request), id);
  response.json({ data: customer });
};

export const customerBookingsController: RequestHandler = async (request, response) => {
  const { id } = parseOrThrow(idParamSchema, request.params);
  const { page, pageSize } = parseOrThrow(customerBookingsQuerySchema, request.query);
  response.json(await listCustomerBookings(getBusinessId(request), id, page, pageSize));
};
