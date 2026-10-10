import { Router } from 'express';
import {
  archiveServiceController,
  createListingController,
  createServiceController,
  createVenueController,
  createVenueBlackoutController,
  getListingController,
  getPublicCategoriesController,
  getPublicListingController,
  getServiceController,
  getVenueController,
  listPublicListingsController,
  listListingsController,
  listServicesController,
  listVenueBlackoutsController,
  listVenuesController,
  publishListingController,
  publicAvailabilityController,
  removeVenueBlackoutController,
  unpublishListingController,
  updateListingController,
  updateServiceController,
  updateVenueController,
  venueAvailabilityController,
} from '../controllers/catalogue.controller.js';
import { authenticate, requirePermission } from '../middleware/auth.middleware.js';

export const venueRouter = Router();
venueRouter.use(authenticate);
venueRouter.get('/', requirePermission('venues.read'), listVenuesController);
venueRouter.post('/', requirePermission('venues.write'), createVenueController);
venueRouter.get('/:id/availability', requirePermission('venues.read'), venueAvailabilityController);
venueRouter.get('/:id/blackouts', requirePermission('venues.read'), listVenueBlackoutsController);
venueRouter.post('/:id/blackouts', requirePermission('venues.write'), createVenueBlackoutController);
venueRouter.delete('/:id/blackouts/:blackoutId', requirePermission('venues.write'), removeVenueBlackoutController);
venueRouter.get('/:id', requirePermission('venues.read'), getVenueController);
venueRouter.patch('/:id', requirePermission('venues.write'), updateVenueController);

export const serviceRouter = Router();
serviceRouter.use(authenticate);
serviceRouter.get('/', requirePermission('catalogue.read'), listServicesController);
serviceRouter.post('/', requirePermission('catalogue.write'), createServiceController);
serviceRouter.get('/:id', requirePermission('catalogue.read'), getServiceController);
serviceRouter.patch('/:id', requirePermission('catalogue.write'), updateServiceController);
serviceRouter.post('/:id/archive', requirePermission('catalogue.write'), archiveServiceController);

export const listingRouter = Router();
listingRouter.use(authenticate);
listingRouter.get('/', requirePermission('catalogue.read'), listListingsController);
listingRouter.post('/', requirePermission('catalogue.write'), createListingController);
listingRouter.get('/:id', requirePermission('catalogue.read'), getListingController);
listingRouter.patch('/:id', requirePermission('catalogue.write'), updateListingController);
listingRouter.post('/:id/publish', requirePermission('catalogue.publish'), publishListingController);
listingRouter.post('/:id/unpublish', requirePermission('catalogue.publish'), unpublishListingController);

export const publicCatalogueRouter = Router();
publicCatalogueRouter.get('/listings', listPublicListingsController);
publicCatalogueRouter.get('/categories', getPublicCategoriesController);
publicCatalogueRouter.get('/availability', publicAvailabilityController);
publicCatalogueRouter.get('/listings/:listingId', getPublicListingController);
