import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../middleware/http-error.js';
import {
  convertEnquiryToBooking,
  createPublicEnquiry,
  getEnquiry,
  listEnquiries,
  updateEnquiry,
} from '../services/enquiry.service.js';
import {
  convertEnquirySchema,
  enquiryIdSchema,
  enquiryListSchema,
  publicEnquirySchema,
  updateEnquirySchema,
} from '../validation/enquiry.schemas.js';
import { parseOrThrow } from '../validation/parse.js';

const authContext = (request: Parameters<RequestHandler>[0]) => {
  const context = request.authContext;
  if (!context) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return context;
};

export const createPublicEnquiryController: RequestHandler = async (request, response) => {
  if (!env.PUBLIC_BUSINESS_ID) {
    throw new AppError(503, 'PUBLIC_STORE_UNAVAILABLE', 'The public enquiry form is not configured.');
  }
  const input = parseOrThrow(publicEnquirySchema, request.body);
  const enquiry = await createPublicEnquiry(env.PUBLIC_BUSINESS_ID, input);
  response.status(201).json({
    data: { id: enquiry.id, reference: enquiry.reference, status: enquiry.status },
  });
};

export const listEnquiriesController: RequestHandler = async (request, response) => {
  const context = authContext(request);
  const query = parseOrThrow(enquiryListSchema, request.query);
  response.json(await listEnquiries(context.businessId, query));
};

export const getEnquiryController: RequestHandler = async (request, response) => {
  const context = authContext(request);
  const { id } = parseOrThrow(enquiryIdSchema, request.params);
  const enquiry = await getEnquiry(context.businessId, id);
  response.setHeader('ETag', `W/"${enquiry.version}"`);
  response.json({ data: enquiry });
};

export const updateEnquiryController: RequestHandler = async (request, response) => {
  const context = authContext(request);
  const { id } = parseOrThrow(enquiryIdSchema, request.params);
  const input = parseOrThrow(updateEnquirySchema, request.body);
  const enquiry = await updateEnquiry(
    context.businessId,
    id,
    context.userId,
    String(request.id),
    input,
  );
  response.setHeader('ETag', `W/"${enquiry.version}"`);
  response.json({ data: enquiry });
};

export const convertEnquiryController: RequestHandler = async (request, response) => {
  const context = authContext(request);
  const { id } = parseOrThrow(enquiryIdSchema, request.params);
  const input = parseOrThrow(convertEnquirySchema, request.body);
  const booking = await convertEnquiryToBooking(
    context.businessId,
    context.userId,
    String(request.id),
    id,
    input,
  );
  response.status(201).json({ data: booking });
};
