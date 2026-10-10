import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { AppError } from '../middleware/http-error.js';
import { AuditEvent } from '../models/audit-event.model.js';
import { Booking } from '../models/booking.model.js';
import { CloudinaryAsset } from '../models/cloudinary-asset.model.js';
import { InventoryAllocation } from '../models/inventory-allocation.model.js';
import { Listing } from '../models/listing.model.js';
import { VenueBlackout } from '../models/venue-blackout.model.js';
import { isInventoryImageOwnedByBusiness } from './cloudinary.service.js';

type ListingKind = 'rental' | 'venue' | 'planning';
type ListingInput = Record<string, unknown> & {
  version?: number;
  imageUrl?: unknown;
  imagePublicId?: unknown;
};

interface ListInput {
  q?: string;
  category?: string;
  kind?: ListingKind;
  active?: boolean;
  status?: string;
  minCapacity?: number;
  guestCount?: number;
  eventDate?: string;
  page: number;
  pageSize: number;
  sort: 'newest' | 'price_asc' | 'price_desc' | 'popular';
}

const notFound = (): AppError => new AppError(404, 'NOT_FOUND', 'Catalogue item was not found.');
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const checkImage = async (
  businessId: string,
  input: { imageUrl?: unknown; imagePublicId?: unknown },
): Promise<void> => {
  const imageUrl = input.imageUrl;
  const imagePublicId = input.imagePublicId;
  if (imageUrl == null && imagePublicId == null) return;
  if (
    typeof imageUrl !== 'string' ||
    typeof imagePublicId !== 'string' ||
    !isInventoryImageOwnedByBusiness(businessId, imagePublicId)
  ) {
    throw new AppError(422, 'INVALID_IMAGE', 'Use an image uploaded for this business.');
  }

  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    throw new AppError(422, 'INVALID_IMAGE', 'The listing image URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'res.cloudinary.com' ||
    !env.CLOUDINARY_CLOUD_NAME ||
    !url.pathname.startsWith(`/${env.CLOUDINARY_CLOUD_NAME}/image/upload/`)
  ) {
    throw new AppError(422, 'INVALID_IMAGE', 'The listing image URL is not a verified Cloudinary asset.');
  }
  const asset = await CloudinaryAsset.findOne({
    businessId,
    publicId: imagePublicId,
    secureUrl: imageUrl,
  }).select('_id');
  if (!asset) throw new AppError(422, 'INVALID_IMAGE', 'Use an image uploaded for this business.');
};

const setSort = (sort: ListInput['sort']): Record<string, 1 | -1> => {
  if (sort === 'price_asc') return { priceKobo: 1, id: 1 };
  if (sort === 'price_desc') return { priceKobo: -1, id: 1 };
  if (sort === 'popular') return { popular: -1, sortOrder: 1, createdAt: -1 };
  return { createdAt: -1, id: 1 };
};

const adminFilter = (businessId: string, input: ListInput, kind?: ListingKind) => {
  const filter: Record<string, unknown> = { businessId };
  if (kind ?? input.kind) filter.kind = kind ?? input.kind;
  if (input.category) filter.category = input.category;
  if (input.active !== undefined) filter.active = input.active;
  if (input.status) {
    if (input.status === 'archived') filter.active = false;
    else if (input.status === 'active') filter.active = true;
    else filter.status = input.status;
  }
  if (input.minCapacity !== undefined) filter.capacity = { $gte: input.minCapacity };
  if (input.guestCount !== undefined) filter.$or = [
    { kind: { $ne: 'venue' } },
    { capacity: null },
    { capacity: { $gte: input.guestCount } },
  ];
  if (input.q) {
    const query = new RegExp(escapeRegex(input.q), 'i');
    filter.$and = [
      ...(Array.isArray(filter.$or) ? [{ $or: filter.$or }] : []),
      { $or: [{ name: query }, { category: query }, { description: query }] },
    ];
    delete filter.$or;
  }
  return filter;
};

const toPublicListing = (listing: {
  id: string;
  name: string;
  kind: ListingKind;
  category: string;
  description?: string;
  priceKobo: number;
  unit: string;
  capacity?: number | null;
  amenities?: string[];
  features?: string[];
  address?: string | null;
  imageUrl?: string | null;
  popular?: boolean;
}) => ({
  id: listing.id,
  name: listing.name,
  kind: listing.kind,
  category: listing.category,
  description: listing.description ?? '',
  priceKobo: listing.priceKobo,
  unit: listing.unit,
  ...(listing.kind === 'venue'
    ? {
        capacity: listing.capacity ?? null,
        amenities: listing.amenities ?? [],
        address: listing.address ?? null,
      }
    : listing.kind === 'planning'
      ? { features: listing.features ?? [] }
      : {}),
  imageUrl: listing.imageUrl ?? null,
  popular: listing.popular ?? false,
});

const requirePublicBusinessId = (): string => {
  if (!env.PUBLIC_BUSINESS_ID) {
    throw new AppError(503, 'PUBLIC_STOREFRONT_NOT_CONFIGURED', 'The public storefront business is not configured.');
  }
  return env.PUBLIC_BUSINESS_ID;
};

const audit = async (
  businessId: string,
  actorId: string,
  requestId: string,
  id: string,
  action: string,
  details: Record<string, unknown> = {},
) => AuditEvent.create({
  businessId,
  actorId,
  requestId,
  resourceType: 'listing',
  resourceId: id,
  action,
  details,
});

export const listAdminListings = async (
  businessId: string,
  input: ListInput,
  kind?: ListingKind,
) => {
  const filter = adminFilter(businessId, input, kind);
  const [data, total] = await Promise.all([
    Listing.find(filter)
      .sort(setSort(input.sort))
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean(),
    Listing.countDocuments(filter),
  ]);
  return { data, meta: { page: input.page, pageSize: input.pageSize, total, totalPages: Math.ceil(total / input.pageSize) } };
};

export const getAdminListing = async (businessId: string, id: string, kind?: ListingKind) => {
  const listing = await Listing.findOne({ businessId, id, ...(kind ? { kind } : {}) }).lean();
  if (!listing) throw notFound();
  return listing;
};

export const getServiceDetails = async (businessId: string, id: string) => {
  const listing = await getAdminListing(businessId, id, 'planning');
  const usage = await Booking.aggregate<{ _id: string; count: number }>([
    { $match: { businessId, 'lines.listingId': id } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const counts = new Map(usage.map(({ _id, count }) => [_id, count]));
  return {
    ...listing,
    usage: {
      bookings: usage.reduce((sum, row) => sum + row.count, 0),
      pending: counts.get('pending') ?? 0,
      confirmed: counts.get('confirmed') ?? 0,
      completed: counts.get('completed') ?? 0,
      cancelled: counts.get('cancelled') ?? 0,
    },
  };
};

export const createListing = async (
  businessId: string,
  actorId: string,
  requestId: string,
  kind: ListingKind,
  input: ListingInput,
) => {
  await checkImage(businessId, input);
  const { version: _version, ...fields } = input;
  const listing = await Listing.create({
    id: randomUUID(),
    businessId,
    kind,
    ...fields,
  });
  await audit(businessId, actorId, requestId, listing.id, 'catalogue.created', { kind });
  return listing.toObject();
};

export const updateListing = async (
  businessId: string,
  id: string,
  kind: ListingKind,
  input: ListingInput,
  actorId: string,
  requestId: string,
) => {
  await checkImage(businessId, input);
  const version = input.version;
  if (typeof version !== 'number') throw new AppError(422, 'VALIDATION_FAILED', 'A listing version is required.');
  const { version: _version, ...updates } = input;

  if (kind === 'venue') {
    const current = await Listing.findOne({ businessId, id, kind }).select('capacity bufferBeforeMinutes bufferAfterMinutes').lean();
    if (!current) throw notFound();
    const bufferChanged =
      (updates.bufferBeforeMinutes !== undefined && updates.bufferBeforeMinutes !== current.bufferBeforeMinutes) ||
      (updates.bufferAfterMinutes !== undefined && updates.bufferAfterMinutes !== current.bufferAfterMinutes);
    if (bufferChanged) {
      const hasConfirmedBooking = await Booking.exists({
        businessId,
        status: 'confirmed',
        'lines.listingId': id,
      });
      if (hasConfirmedBooking) {
        throw new AppError(409, 'VENUE_BUFFER_IN_USE', 'Venue booking buffers cannot change while confirmed bookings exist.');
      }
    }
  }

  if (kind === 'venue' && typeof updates.capacity === 'number') {
    const confirmedBookings = await Booking.find({
      businessId,
      status: 'confirmed',
      'lines.listingId': id,
      guestCount: { $gt: updates.capacity },
    }).select('id').limit(1).lean();
    if (confirmedBookings.length) {
      throw new AppError(409, 'CAPACITY_BELOW_CONFIRMED_BOOKING', 'Venue capacity cannot be reduced below a confirmed booking guest count.');
    }
  }

  const listing = await Listing.findOneAndUpdate(
    { businessId, id, kind, version },
    { $set: updates, $inc: { version: 1, ...(kind === 'venue' ? { allocationVersion: 1 } : {}) } },
    { new: true, runValidators: true },
  ).lean();
  if (!listing) {
    const current = await Listing.findOne({ businessId, id, kind }).select('version').lean();
    if (!current) throw notFound();
    throw new AppError(409, 'VERSION_CONFLICT', 'Catalogue item changed; reload and retry.', undefined, { ETag: `W/"${current.version}"` });
  }
  await audit(businessId, actorId, requestId, id, 'catalogue.updated', { version: listing.version });
  return listing;
};

export const setListingPublished = async (
  businessId: string,
  id: string,
  published: boolean,
  actorId: string,
  requestId: string,
) => {
  const listing = await Listing.findOneAndUpdate(
    { businessId, id },
    { $set: { published }, $inc: { version: 1 } },
    { new: true },
  ).lean();
  if (!listing) throw notFound();
  await audit(businessId, actorId, requestId, id, published ? 'catalogue.published' : 'catalogue.unpublished');
  return listing;
};

export const archiveListing = async (
  businessId: string,
  id: string,
  kind: 'planning',
  actorId: string,
  requestId: string,
) => {
  const listing = await Listing.findOneAndUpdate(
    { businessId, id, kind },
    { $set: { active: false, published: false }, $inc: { version: 1 } },
    { new: true },
  ).lean();
  if (!listing) throw notFound();
  await audit(businessId, actorId, requestId, id, 'catalogue.archived');
  return listing;
};

export const listPublicListings = async (input: ListInput) => {
  const businessId = requirePublicBusinessId();
  const filter = adminFilter(businessId, input);
  filter.active = true;
  filter.published = true;
  if (input.eventDate) {
    const candidates = await Listing.find(filter)
      .sort(setSort(input.sort))
      .limit(501)
      .lean();
    if (candidates.length > 500) {
      throw new AppError(
        422,
        'DATE_FILTER_TOO_BROAD',
        'Add a category, listing type, or search term to narrow the date-filtered catalogue.',
      );
    }
    const startAt = new Date(`${input.eventDate}T00:00:00+01:00`);
    const endAt = new Date(startAt.getTime() + 24 * 60 * 60_000);
    const availability: boolean[] = [];
    for (let index = 0; index < candidates.length; index += 20) {
      const batch = candidates.slice(index, index + 20);
      availability.push(...await Promise.all(
        batch.map((listing) =>
          listing.kind === 'planning'
            ? Promise.resolve(true)
            : checkListingAvailability(listing.id, startAt, endAt, 1, businessId, input.guestCount)
              .then((result) => result.available),
        ),
      ));
    }
    const available = candidates.filter((_listing, index) => availability[index]);
    const total = available.length;
    const start = (input.page - 1) * input.pageSize;
    return {
      data: available.slice(start, start + input.pageSize).map(toPublicListing),
      meta: { page: input.page, pageSize: input.pageSize, total, totalPages: Math.ceil(total / input.pageSize) },
    };
  }
  const [data, total] = await Promise.all([
    Listing.find(filter)
      .sort(setSort(input.sort))
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean(),
    Listing.countDocuments(filter),
  ]);
  return {
    data: data.map(toPublicListing),
    meta: { page: input.page, pageSize: input.pageSize, total, totalPages: Math.ceil(total / input.pageSize) },
  };
};

export const getPublicListing = async (id: string) => {
  const listing = await Listing.findOne({
    businessId: requirePublicBusinessId(),
    id,
    active: true,
    published: true,
  }).lean();
  if (!listing) throw notFound();
  return toPublicListing(listing);
};

export const getPublicCategories = async () => {
  const rows = await Listing.aggregate<{ _id: string; count: number }>([
    { $match: { businessId: requirePublicBusinessId(), active: true, published: true } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map(({ _id, count }) => ({ category: _id, count }));
};

const paddedInterval = (startAt: Date, endAt: Date, beforeMinutes: number, afterMinutes: number) => ({
  startAt: new Date(startAt.getTime() - beforeMinutes * 60_000),
  endAt: new Date(endAt.getTime() + afterMinutes * 60_000),
});

export const checkListingAvailability = async (
  listingId: string,
  startAt: Date,
  endAt: Date,
  quantity: number,
  scopedBusinessId?: string,
  guestCount?: number,
) => {
  const businessId = scopedBusinessId ?? requirePublicBusinessId();
  const listing = await Listing.findOne({
    businessId,
    id: listingId,
    active: true,
    ...(scopedBusinessId ? {} : { published: true }),
  }).lean();
  if (!listing) throw notFound();

  if (listing.kind === 'planning') {
    return { listingId, startAt, endAt, requestedQuantity: quantity, availableUnits: null, available: true };
  }

  const interval = listing.kind === 'venue'
    ? paddedInterval(startAt, endAt, listing.bufferBeforeMinutes ?? 0, listing.bufferAfterMinutes ?? 0)
    : { startAt, endAt };
  if (listing.kind === 'venue' && listing.status !== 'available') {
    return { listingId, startAt, endAt, requestedQuantity: quantity, availableUnits: 0, available: false };
  }
  if (
    listing.kind === 'venue' &&
    guestCount !== undefined &&
    listing.capacity !== null &&
    listing.capacity !== undefined &&
    guestCount > listing.capacity
  ) {
    return { listingId, startAt, endAt, requestedQuantity: quantity, availableUnits: 0, available: false };
  }

  const blackout = listing.kind === 'venue' && await VenueBlackout.exists({
    businessId,
    venueId: listingId,
    startAt: { $lt: interval.endAt },
    endAt: { $gt: interval.startAt },
  });
  if (blackout) {
    return { listingId, startAt, endAt, requestedQuantity: quantity, availableUnits: 0, available: false };
  }

  const allocations = await InventoryAllocation.find({
    businessId,
    listingId,
    status: 'active',
    startAt: { $lt: interval.endAt },
    endAt: { $gt: interval.startAt },
  }).select('quantity startAt endAt').lean();
  const events = allocations.flatMap((allocation) => [
    {
      time: Math.max(allocation.startAt.getTime(), interval.startAt.getTime()),
      quantity: allocation.quantity,
    },
    {
      time: Math.min(allocation.endAt.getTime(), interval.endAt.getTime()),
      quantity: -allocation.quantity,
    },
  ]).sort((left, right) => left.time - right.time || left.quantity - right.quantity);
  let allocated = 0;
  let peakAllocated = 0;
  for (const event of events) {
    allocated += event.quantity;
    peakAllocated = Math.max(peakAllocated, allocated);
  }

  if (listing.kind === 'venue') {
    const available = peakAllocated === 0;
    return { listingId, startAt, endAt, requestedQuantity: quantity, availableUnits: available ? 1 : 0, available };
  }

  const availableUnits = Math.max(
    0,
    (listing.totalUnits ?? 0) - (listing.damagedUnits ?? 0) - (listing.missingUnits ?? 0) - peakAllocated,
  );
  return { listingId, startAt, endAt, requestedQuantity: quantity, availableUnits, available: availableUnits >= quantity };
};

export const listVenueBlackouts = async (businessId: string, venueId: string) => {
  const venue = await Listing.findOne({ businessId, id: venueId, kind: 'venue' }).select('id').lean();
  if (!venue) throw notFound();
  return VenueBlackout.find({ businessId, venueId }).sort({ startAt: 1 }).lean();
};

export const createVenueBlackout = async (
  businessId: string,
  venueId: string,
  input: { startAt: string; endAt: string; reason: string },
  actorId: string,
  requestId: string,
) => {
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  const blackout = await mongoose.connection.transaction(async (session) => {
    const venue = await Listing.findOne({ businessId, id: venueId, kind: 'venue' }).session(session);
    if (!venue) throw notFound();
    const lock = await Listing.updateOne(
      { businessId, id: venueId, kind: 'venue', allocationVersion: venue.allocationVersion },
      { $inc: { allocationVersion: 1 } },
      { session },
    );
    if (lock.modifiedCount !== 1) throw new AppError(409, 'AVAILABILITY_CONFLICT', 'Venue availability changed; retry blackout creation.');

    const interval = paddedInterval(startAt, endAt, venue.bufferBeforeMinutes ?? 0, venue.bufferAfterMinutes ?? 0);
    const allocation = await InventoryAllocation.exists({
      businessId,
      listingId: venueId,
      status: 'active',
      startAt: { $lt: interval.endAt },
      endAt: { $gt: interval.startAt },
    }).session(session);
    const existingBlackout = await VenueBlackout.exists({
      businessId,
      venueId,
      startAt: { $lt: interval.endAt },
      endAt: { $gt: interval.startAt },
    }).session(session);
    if (allocation || existingBlackout) {
      throw new AppError(409, 'VENUE_INTERVAL_UNAVAILABLE', 'The blackout overlaps an existing booking or blackout.');
    }
    const [created] = await VenueBlackout.create(
      [{
        id: randomUUID(),
        businessId,
        venueId,
        startAt,
        endAt,
        reason: input.reason,
        createdBy: actorId,
      }],
      { session },
    );
    if (!created) throw new Error('Venue blackout creation failed.');
    await AuditEvent.create(
      [{
        businessId,
        actorId,
        requestId,
        resourceType: 'venue',
        resourceId: venueId,
        action: 'venue.blackout_created',
        details: { blackoutId: created.id },
      }],
      { session },
    );
    return created.toObject();
  });
  return blackout;
};

export const removeVenueBlackout = async (
  businessId: string,
  venueId: string,
  blackoutId: string,
  actorId: string,
  requestId: string,
) => {
  const removed = await mongoose.connection.transaction(async (session) => {
    const venue = await Listing.findOne({ businessId, id: venueId, kind: 'venue' }).session(session);
    if (!venue) throw notFound();
    const lock = await Listing.updateOne(
      { businessId, id: venueId, kind: 'venue', allocationVersion: venue.allocationVersion },
      { $inc: { allocationVersion: 1 } },
      { session },
    );
    if (lock.modifiedCount !== 1) throw new AppError(409, 'VERSION_CONFLICT', 'Venue changed; retry blackout removal.');
    const result = await VenueBlackout.findOneAndDelete({ businessId, venueId, id: blackoutId }).session(session);
    if (!result) throw new AppError(404, 'NOT_FOUND', 'Venue blackout was not found.');
    await AuditEvent.create(
      [{
        businessId,
        actorId,
        requestId,
        resourceType: 'venue',
        resourceId: venueId,
        action: 'venue.blackout_removed',
        details: { blackoutId },
      }],
      { session },
    );
    return result;
  });
  return removed;
};

export const archiveService = archiveListing;
