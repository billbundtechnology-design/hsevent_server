import type { RequestHandler } from 'express';
import { AppError } from '../middleware/http-error.js';
import {
  archiveService,
  checkListingAvailability,
  createListing,
  createVenueBlackout,
  getAdminListing,
  getPublicCategories,
  getPublicListing,
  getServiceDetails,
  listAdminListings,
  listPublicListings,
  listVenueBlackouts,
  removeVenueBlackout,
  setListingPublished,
  updateListing,
} from '../services/catalogue.service.js';
import {
  blackoutCreateSchema,
  blackoutIdSchema,
  catalogueListSchema,
  listingCreateSchema,
  listingIdSchema,
  listingUpdateSchema,
  publicAvailabilitySchema,
  publicListingListSchema,
  serviceCreateSchema,
  serviceUpdateSchema,
  venueCreateSchema,
  venueUpdateSchema,
  venueAvailabilitySchema,
} from '../validation/catalogue.schemas.js';
import { parseOrThrow } from '../validation/parse.js';

const context = (request: Parameters<RequestHandler>[0]) => {
  if (!request.authContext) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return request.authContext;
};

const requestId = (request: Parameters<RequestHandler>[0]) => String(request.id);

const listForKind = (kind: 'venue' | 'planning') =>
  (async (request, response) => {
    const { businessId } = context(request);
    const input = parseOrThrow(catalogueListSchema, request.query);
    response.json(await listAdminListings(businessId, input, kind));
  }) as RequestHandler;

const getForKind = (kind: 'venue' | 'planning') =>
  (async (request, response) => {
    const { businessId } = context(request);
    const { id } = parseOrThrow(listingIdSchema, request.params);
    const listing = await getAdminListing(businessId, id, kind);
    response.setHeader('ETag', `W/"${listing.version}"`);
    response.json({ data: listing });
  }) as RequestHandler;

const createForKind = (kind: 'venue' | 'planning') =>
  (async (request, response) => {
    const auth = context(request);
    const schema = kind === 'venue' ? venueCreateSchema : serviceCreateSchema;
    const input = parseOrThrow(schema, request.body);
    const listing = await createListing(auth.businessId, auth.userId, requestId(request), kind, input);
    response.setHeader('ETag', `W/"${listing.version}"`);
    response.status(201).json({ data: listing });
  }) as RequestHandler;

const updateForKind = (kind: 'venue' | 'planning') =>
  (async (request, response) => {
    const auth = context(request);
    const { id } = parseOrThrow(listingIdSchema, request.params);
    const schema = kind === 'venue' ? venueUpdateSchema : serviceUpdateSchema;
    const input = parseOrThrow(schema, request.body);
    const listing = await updateListing(
      auth.businessId,
      id,
      kind,
      input,
      auth.userId,
      requestId(request),
    );
    response.setHeader('ETag', `W/"${listing.version}"`);
    response.json({ data: listing });
  }) as RequestHandler;

export const listVenuesController = listForKind('venue');
export const getVenueController = getForKind('venue');
export const createVenueController = createForKind('venue');
export const updateVenueController = updateForKind('venue');
export const listServicesController = listForKind('planning');
export const getServiceController: RequestHandler = async (request, response) => {
  const { businessId } = context(request);
  const { id } = parseOrThrow(listingIdSchema, request.params);
  const listing = await getServiceDetails(businessId, id);
  response.setHeader('ETag', `W/"${listing.version}"`);
  response.json({ data: listing });
};
export const createServiceController = createForKind('planning');
export const updateServiceController = updateForKind('planning');

export const archiveServiceController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id } = parseOrThrow(listingIdSchema, request.params);
  response.json({
    data: await archiveService(auth.businessId, id, 'planning', auth.userId, requestId(request)),
  });
};

export const listListingsController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const input = parseOrThrow(catalogueListSchema, request.query);
  response.json(await listAdminListings(auth.businessId, input));
};

export const createListingController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const input = parseOrThrow(listingCreateSchema, request.body);
  const listing = await createListing(auth.businessId, auth.userId, requestId(request), input.kind, input);
  response.setHeader('ETag', `W/"${listing.version}"`);
  response.status(201).json({ data: listing });
};

export const getListingController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id } = parseOrThrow(listingIdSchema, request.params);
  const listing = await getAdminListing(auth.businessId, id);
  response.setHeader('ETag', `W/"${listing.version}"`);
  response.json({ data: listing });
};

export const updateListingController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id } = parseOrThrow(listingIdSchema, request.params);
  const input = parseOrThrow(listingUpdateSchema, request.body);
  const current = await getAdminListing(auth.businessId, id);
  if (current.kind === 'rental') {
    throw new AppError(422, 'USE_INVENTORY_ENDPOINT', 'Update rental listings through the inventory endpoints.');
  }
  const listing = await updateListing(
    auth.businessId,
    id,
    current.kind,
    input,
    auth.userId,
    requestId(request),
  );
  response.setHeader('ETag', `W/"${listing.version}"`);
  response.json({ data: listing });
};

const publicationController = (published: boolean): RequestHandler =>
  async (request, response) => {
    const auth = context(request);
    const { id } = parseOrThrow(listingIdSchema, request.params);
    const listing = await setListingPublished(
      auth.businessId,
      id,
      published,
      auth.userId,
      requestId(request),
    );
    response.setHeader('ETag', `W/"${listing.version}"`);
    response.json({ data: listing });
  };

export const publishListingController = publicationController(true);
export const unpublishListingController = publicationController(false);

export const listPublicListingsController: RequestHandler = async (request, response) => {
  const input = parseOrThrow(publicListingListSchema, request.query);
  response.json(await listPublicListings(input));
};

export const getPublicListingController: RequestHandler = async (request, response) => {
  const { id } = parseOrThrow(listingIdSchema, { id: request.params.listingId });
  response.json({ data: await getPublicListing(id) });
};

export const getPublicCategoriesController: RequestHandler = async (_request, response) => {
  response.json({ data: await getPublicCategories() });
};

export const publicAvailabilityController: RequestHandler = async (request, response) => {
  const input = parseOrThrow(publicAvailabilitySchema, request.query);
  response.json({
    data: await checkListingAvailability(
      input.listingId,
      new Date(input.startAt),
      new Date(input.endAt),
      input.quantity,
      undefined,
      input.guestCount,
    ),
  });
};

export const venueAvailabilityController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id } = parseOrThrow(listingIdSchema, request.params);
  const input = parseOrThrow(venueAvailabilitySchema, request.query);
  response.json({
    data: await checkListingAvailability(
      id,
      new Date(input.startAt),
      new Date(input.endAt),
      1,
      auth.businessId,
      input.guestCount,
    ),
  });
};

export const listVenueBlackoutsController: RequestHandler = async (request, response) => {
  const { businessId } = context(request);
  const { id } = parseOrThrow(listingIdSchema, request.params);
  response.json({ data: await listVenueBlackouts(businessId, id) });
};

export const createVenueBlackoutController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id } = parseOrThrow(listingIdSchema, request.params);
  const input = parseOrThrow(blackoutCreateSchema, request.body);
  response.status(201).json({
    data: await createVenueBlackout(auth.businessId, id, input, auth.userId, requestId(request)),
  });
};

export const removeVenueBlackoutController: RequestHandler = async (request, response) => {
  const auth = context(request);
  const { id, blackoutId } = parseOrThrow(blackoutIdSchema, request.params);
  response.json({
    data: await removeVenueBlackout(auth.businessId, id, blackoutId, auth.userId, requestId(request)),
  });
};
