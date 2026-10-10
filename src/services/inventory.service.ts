import { randomUUID } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { AppError } from '../middleware/http-error.js';
import { AuditEvent } from '../models/audit-event.model.js';
import { CloudinaryAsset } from '../models/cloudinary-asset.model.js';
import { InventoryAllocation } from '../models/inventory-allocation.model.js';
import { Listing } from '../models/listing.model.js';
import { StockMovement } from '../models/stock-movement.model.js';
import { env } from '../config/env.js';
import {
  isInventoryImageOwnedByBusiness,
  type UploadedInventoryImage,
  uploadInventoryImage,
} from './cloudinary.service.js';

const MAX_AVAILABILITY_FILTER_SCAN = 5000;

interface InventoryListInput {
  q?: string;
  category?: string;
  availability?: 'available' | 'low' | 'out_of_stock';
  condition?: 'normal' | 'damaged' | 'missing';
  page: number;
  pageSize: number;
}

const inventoryNotFound = (): AppError =>
  new AppError(404, 'NOT_FOUND', 'Inventory item was not found.');

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assertOwnedImageFormat = (
  businessId: string,
  image: { imageUrl?: string | null; imagePublicId?: string | null },
): void => {
  if (!image.imageUrl && !image.imagePublicId) return;
  if (!image.imageUrl || !image.imagePublicId || !isInventoryImageOwnedByBusiness(businessId, image.imagePublicId)) {
    throw new AppError(422, 'INVALID_IMAGE', 'Use an image uploaded for this business.');
  }

  let url: URL;
  try {
    url = new URL(image.imageUrl);
  } catch {
    throw new AppError(422, 'INVALID_IMAGE', 'The inventory image URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'res.cloudinary.com' ||
    !env.CLOUDINARY_CLOUD_NAME ||
    !url.pathname.startsWith(`/${env.CLOUDINARY_CLOUD_NAME}/image/upload/`)
  ) {
    throw new AppError(422, 'INVALID_IMAGE', 'The inventory image URL is not a verified Cloudinary asset.');
  }
};

const assertStoredImage = async (
  businessId: string,
  image: { imageUrl?: string | null; imagePublicId?: string | null },
): Promise<void> => {
  assertOwnedImageFormat(businessId, image);
  if (!image.imageUrl || !image.imagePublicId) return;
  const asset = await CloudinaryAsset.findOne({
    businessId,
    publicId: image.imagePublicId,
    secureUrl: image.imageUrl,
  }).select('publicId');
  if (!asset) {
    throw new AppError(422, 'INVALID_IMAGE', 'Use an image uploaded for this business.');
  }
};

const maxConcurrentAllocated = async (
  businessId: string,
  listingId: string,
  session?: ClientSession,
): Promise<number> => {
  let query = InventoryAllocation.find({
    businessId,
    listingId,
    status: 'active',
    endAt: { $gt: new Date() },
  }).select('quantity startAt endAt');
  if (session) query = query.session(session);
  const allocations = await query.lean();
  const events = allocations.flatMap((allocation) => [
    { time: allocation.startAt.getTime(), quantity: allocation.quantity },
    { time: allocation.endAt.getTime(), quantity: -allocation.quantity },
  ]).sort((left, right) => left.time - right.time || left.quantity - right.quantity);

  let allocated = 0;
  let peak = 0;
  for (const event of events) {
    allocated += event.quantity;
    peak = Math.max(peak, allocated);
  }
  return peak;
};

interface AllocationStats {
  allocatedUnits: number;
  peakConcurrentAllocatedUnits: number;
}

const getAllocationStats = async (
  businessId: string,
  listingIds: string[],
  interval?: { startAt: Date; endAt: Date },
): Promise<Map<string, AllocationStats>> => {
  const now = new Date();
  const allocations = await InventoryAllocation.find({
    businessId,
    listingId: { $in: listingIds },
    status: 'active',
    ...(interval ? { startAt: { $lt: interval.endAt } } : {}),
    endAt: { $gt: interval?.startAt ?? now },
  })
    .select('listingId quantity startAt endAt')
    .lean();
  const byListing = new Map<string, Array<{ time: number; quantity: number }>>();
  const result = new Map<string, AllocationStats>(
    listingIds.map((listingId) => [
      listingId,
      { allocatedUnits: 0, peakConcurrentAllocatedUnits: 0 },
    ]),
  );

  for (const allocation of allocations) {
    const startAt = interval
      ? Math.max(allocation.startAt.getTime(), interval.startAt.getTime())
      : Math.max(allocation.startAt.getTime(), now.getTime());
    const endAt = interval
      ? Math.min(allocation.endAt.getTime(), interval.endAt.getTime())
      : allocation.endAt.getTime();
    const events = byListing.get(allocation.listingId) ?? [];
    events.push(
      { time: startAt, quantity: allocation.quantity },
      { time: endAt, quantity: -allocation.quantity },
    );
    byListing.set(allocation.listingId, events);

    if (!interval && allocation.startAt <= now && allocation.endAt > now) {
      const stats = result.get(allocation.listingId);
      if (stats) stats.allocatedUnits += allocation.quantity;
    }
  }

  for (const [listingId, events] of byListing) {
    events.sort((left, right) => left.time - right.time || left.quantity - right.quantity);
    let allocatedUnits = 0;
    let peakConcurrentAllocatedUnits = 0;
    for (const event of events) {
      allocatedUnits += event.quantity;
      peakConcurrentAllocatedUnits = Math.max(peakConcurrentAllocatedUnits, allocatedUnits);
    }
    const stats = result.get(listingId);
    if (stats) stats.peakConcurrentAllocatedUnits = peakConcurrentAllocatedUnits;
  }
  return result;
};

const toInventoryItem = async (listing: {
  id: string;
  businessId: string;
  name: string;
  sku?: string | null;
  category: string;
  description?: string;
  totalUnits?: number | null;
  damagedUnits?: number;
  missingUnits?: number;
  priceKobo: number;
  active: boolean;
  published: boolean;
  version: number;
  imageUrl?: string | null;
  imagePublicId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}, allocationStats?: AllocationStats) => {
  const stats = allocationStats ?? (
    await getAllocationStats(listing.businessId, [listing.id])
  ).get(listing.id) ?? { allocatedUnits: 0, peakConcurrentAllocatedUnits: 0 };
  const totalUnits = listing.totalUnits ?? 0;
  const damagedUnits = listing.damagedUnits ?? 0;
  const missingUnits = listing.missingUnits ?? 0;
  return {
    id: listing.id,
    name: listing.name,
    sku: listing.sku ?? null,
    category: listing.category,
    description: listing.description ?? '',
    totalUnits,
    damagedUnits,
    missingUnits,
    allocatedUnits: stats.allocatedUnits,
    availableUnits: Math.max(
      0,
      totalUnits - damagedUnits - missingUnits - stats.allocatedUnits,
    ),
    peakConcurrentAllocatedUnits: stats.peakConcurrentAllocatedUnits,
    rentalRateKobo: listing.priceKobo,
    active: listing.active,
    published: listing.published,
    imageUrl: listing.imageUrl ?? null,
    imagePublicId: listing.imagePublicId ?? null,
    version: listing.version,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
  };
};

export const listInventory = async (businessId: string, input: InventoryListInput) => {
  const filter: Record<string, unknown> = { businessId, kind: 'rental' };
  if (input.category) filter.category = input.category;
  if (input.q) {
    const query = new RegExp(escapeRegex(input.q), 'i');
    filter.$or = [{ name: query }, { sku: query }, { category: query }];
  }
  if (input.condition === 'damaged') filter.damagedUnits = { $gt: 0 };
  if (input.condition === 'missing') filter.missingUnits = { $gt: 0 };
  if (input.condition === 'normal') {
    filter.damagedUnits = 0;
    filter.missingUnits = 0;
  }

  const query = Listing.find(filter).sort({ createdAt: -1, id: 1 });
  query
    .skip(input.availability ? 0 : (input.page - 1) * input.pageSize)
    .limit(input.availability ? MAX_AVAILABILITY_FILTER_SCAN + 1 : input.pageSize);
  const [listings, count] = await Promise.all([
    query.lean(),
    Listing.countDocuments(filter),
  ]);
  const allocationStats = await getAllocationStats(
    businessId,
    listings.map((listing) => listing.id),
  );
  const allItems = await Promise.all(
    listings.map((listing) => toInventoryItem(listing, allocationStats.get(listing.id))),
  );
  if (input.availability && allItems.length > MAX_AVAILABILITY_FILTER_SCAN) {
    throw new AppError(
      422,
      'AVAILABILITY_FILTER_TOO_BROAD',
      'Add a category or search filter to narrow availability results.',
    );
  }
  let data = allItems;
  let total = count;
  if (input.availability) {
    data = data.filter((item) =>
      input.availability === 'out_of_stock'
        ? item.availableUnits === 0
        : input.availability === 'low'
          ? item.availableUnits > 0 && item.availableUnits <= Math.max(1, Math.ceil(item.totalUnits * 0.2))
          : item.availableUnits > Math.max(1, Math.ceil(item.totalUnits * 0.2)),
    );
    total = data.length;
    data = data.slice((input.page - 1) * input.pageSize, input.page * input.pageSize);
  }
  return {
    data,
    meta: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      totalPages: Math.ceil(total / input.pageSize),
    },
  };
};

export const createInventoryItem = async (
  businessId: string,
  actorId: string,
  requestId: string,
  input: {
    name: string;
    sku: string;
    category: string;
    description: string;
    totalUnits: number;
    damagedUnits: number;
    missingUnits: number;
    rentalRateKobo: number;
    unit: string;
    active: boolean;
    published: boolean;
    imageUrl?: string | null;
    imagePublicId?: string | null;
  },
) => {
  await assertStoredImage(businessId, input);
  try {
    const item = await mongoose.connection.transaction(async (session) => {
      const [listing] = await Listing.create(
        [{
          id: randomUUID(),
          businessId,
          name: input.name,
          sku: input.sku,
          kind: 'rental',
          category: input.category,
          description: input.description,
          priceKobo: input.rentalRateKobo,
          unit: input.unit,
          active: input.active,
          published: input.published,
          totalUnits: input.totalUnits,
          damagedUnits: input.damagedUnits,
          missingUnits: input.missingUnits,
          imageUrl: input.imageUrl ?? null,
          imagePublicId: input.imagePublicId ?? null,
        }],
        { session },
      );
      if (!listing) throw new Error('Inventory item creation failed.');
      if (input.totalUnits || input.damagedUnits || input.missingUnits) {
        await StockMovement.create(
          [{
            businessId,
            listingId: listing.id,
            actorId,
            requestId,
            type: 'stock_adjustment',
            quantityDelta: input.totalUnits,
            damagedDelta: input.damagedUnits,
            missingDelta: input.missingUnits,
            totalUnitsAfter: input.totalUnits,
            damagedUnitsAfter: input.damagedUnits,
            missingUnitsAfter: input.missingUnits,
            reason: 'Initial stock',
          }],
          { session },
        );
      }
      await AuditEvent.create(
        [{
          businessId,
          actorId,
          requestId,
          resourceType: 'inventory',
          resourceId: listing.id,
          action: 'inventory.created',
          details: { sku: listing.sku, totalUnits: input.totalUnits },
        }],
        { session },
      );
      return listing;
    });
    return toInventoryItem(item.toObject());
  } catch (error) {
    if (isMongoDuplicateKey(error)) {
      throw new AppError(409, 'SKU_EXISTS', 'An inventory item with this SKU already exists.');
    }
    throw error;
  }
};

const isMongoDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 11000;

export const getInventoryItem = async (businessId: string, id: string) => {
  const listing = await Listing.findOne({ businessId, id, kind: 'rental' }).lean();
  if (!listing) throw inventoryNotFound();
  const [data, movements] = await Promise.all([
    toInventoryItem(listing),
    StockMovement.find({ businessId, listingId: id })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean(),
  ]);
  return { ...data, movements };
};

export const updateInventoryItem = async (
  businessId: string,
  id: string,
  input: {
    name?: string;
    sku?: string;
    category?: string;
    description?: string;
    rentalRateKobo?: number;
    unit?: string;
    active?: boolean;
    published?: boolean;
    imageUrl?: string | null;
    imagePublicId?: string | null;
    version: number;
  },
  actorId: string,
  requestId: string,
) => {
  await assertStoredImage(businessId, input);
  const { version, rentalRateKobo, ...updates } = input;
  try {
    const listing = await Listing.findOneAndUpdate(
      { businessId, id, kind: 'rental', version },
      {
        $set: {
          ...updates,
          ...(rentalRateKobo !== undefined ? { priceKobo: rentalRateKobo } : {}),
        },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true },
    ).lean();
    if (!listing) {
      const current = await Listing.findOne({ businessId, id, kind: 'rental' }).lean();
      if (!current) throw inventoryNotFound();
      throw new AppError(
        409,
        'VERSION_CONFLICT',
        'Inventory item changed; reload and retry.',
        undefined,
        { ETag: `W/"${current.version}"` },
      );
    }
    await AuditEvent.create({
      businessId,
      actorId,
      requestId,
      resourceType: 'inventory',
      resourceId: id,
      action: 'inventory.updated',
      details: { version: listing.version },
    });
    return toInventoryItem(listing);
  } catch (error) {
    if (isMongoDuplicateKey(error)) {
      throw new AppError(409, 'SKU_EXISTS', 'An inventory item with this SKU already exists.');
    }
    throw error;
  }
};

const updateStock = async (
  businessId: string,
  id: string,
  version: number,
  delta: { quantityDelta?: number; damagedDelta?: number; missingDelta?: number },
  reason: string,
  actorId: string,
  requestId: string,
  type: 'stock_adjustment' | 'condition_report',
) => {
  const listing = await mongoose.connection.transaction(async (session) => {
      const item = await Listing.findOne({ businessId, id, kind: 'rental', version }).session(session);
      if (!item) {
        const current = await Listing.findOne({ businessId, id, kind: 'rental' }).session(session);
        if (!current) throw inventoryNotFound();
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'Inventory item changed; reload and retry.',
          undefined,
          { ETag: `W/"${current.version}"` },
        );
      }

      const totalUnits = item.totalUnits ?? 0;
      const damagedUnits = (item.damagedUnits ?? 0) + (delta.damagedDelta ?? 0);
      const missingUnits = (item.missingUnits ?? 0) + (delta.missingDelta ?? 0);
      const nextTotalUnits = totalUnits + (delta.quantityDelta ?? 0);
      if (nextTotalUnits < 0 || damagedUnits < 0 || missingUnits < 0) {
        throw new AppError(422, 'INVALID_STOCK', 'Stock and condition counts cannot be negative.');
      }
      if (damagedUnits + missingUnits > nextTotalUnits) {
        throw new AppError(422, 'INVALID_STOCK', 'Damaged and missing units cannot exceed total stock.');
      }
      const allocatedUnits = await maxConcurrentAllocated(businessId, id, session);
      if (nextTotalUnits - damagedUnits - missingUnits < allocatedUnits) {
        throw new AppError(
          409,
          'STOCK_BELOW_ALLOCATED',
          'Stock cannot be reduced below concurrently allocated quantities.',
        );
      }

      const allocationLock = await Listing.updateOne(
        { businessId, id, kind: 'rental', version, allocationVersion: item.allocationVersion },
        {
          $set: {
            totalUnits: nextTotalUnits,
            damagedUnits,
            missingUnits,
          },
          $inc: { allocationVersion: 1, version: 1 },
        },
        { session },
      );
      if (allocationLock.modifiedCount !== 1) {
        throw new AppError(409, 'VERSION_CONFLICT', 'Inventory changed concurrently; reload and retry.');
      }

      await StockMovement.create(
        [{
          businessId,
          listingId: id,
          actorId,
          requestId,
          type,
          quantityDelta: delta.quantityDelta ?? 0,
          damagedDelta: delta.damagedDelta ?? 0,
          missingDelta: delta.missingDelta ?? 0,
          totalUnitsAfter: nextTotalUnits,
          damagedUnitsAfter: damagedUnits,
          missingUnitsAfter: missingUnits,
          reason,
        }],
        { session },
      );
      await AuditEvent.create(
        [{
          businessId,
          actorId,
          requestId,
          resourceType: 'inventory',
          resourceId: id,
          action: type === 'stock_adjustment' ? 'inventory.stock_adjusted' : 'inventory.condition_reported',
          details: {
            quantityDelta: delta.quantityDelta ?? 0,
            damagedDelta: delta.damagedDelta ?? 0,
            missingDelta: delta.missingDelta ?? 0,
            totalUnitsAfter: nextTotalUnits,
            damagedUnitsAfter: damagedUnits,
            missingUnitsAfter: missingUnits,
          },
        }],
        { session },
      );
      return Listing.findOne({ businessId, id, kind: 'rental' }).session(session);
  });
  if (!listing) throw inventoryNotFound();
  return toInventoryItem(listing.toObject());
};

export const adjustStock = async (
  businessId: string,
  id: string,
  input: { quantityDelta: number; reason: string; version: number },
  actorId: string,
  requestId: string,
) => updateStock(
  businessId,
  id,
  input.version,
  { quantityDelta: input.quantityDelta },
  input.reason,
  actorId,
  requestId,
  'stock_adjustment',
);

export const reportCondition = async (
  businessId: string,
  id: string,
  input: { damagedDelta: number; missingDelta: number; reason: string; version: number },
  actorId: string,
  requestId: string,
) => updateStock(
  businessId,
  id,
  input.version,
  { damagedDelta: input.damagedDelta, missingDelta: input.missingDelta },
  input.reason,
  actorId,
  requestId,
  'condition_report',
);

export const getInventoryAvailability = async (
  businessId: string,
  id: string,
  input: { startAt: string; endAt: string; quantity: number },
) => {
  const listing = await Listing.findOne({ businessId, id, kind: 'rental', active: true }).lean();
  if (!listing) throw inventoryNotFound();
  const allocationStats = await getAllocationStats(businessId, [id], {
    startAt: new Date(input.startAt),
    endAt: new Date(input.endAt),
  });
  const allocatedUnits = allocationStats.get(id)?.peakConcurrentAllocatedUnits ?? 0;
  const availableUnits = Math.max(
    0,
    (listing.totalUnits ?? 0) - (listing.damagedUnits ?? 0) - (listing.missingUnits ?? 0) - allocatedUnits,
  );
  return {
    id,
    startAt: input.startAt,
    endAt: input.endAt,
    requestedQuantity: input.quantity,
    availableUnits,
    available: availableUnits >= input.quantity,
  };
};

export const uploadInventoryImageForBusiness = async (
  businessId: string,
  uploadedBy: string,
  file: Express.Multer.File,
): Promise<UploadedInventoryImage> => {
  const image = await uploadInventoryImage(businessId, file);
  if (!isInventoryImageOwnedByBusiness(businessId, image.publicId)) {
    throw new AppError(502, 'IMAGE_UPLOAD_FAILED', 'Uploaded image ownership could not be verified.');
  }
  await CloudinaryAsset.create({
    businessId,
    uploadedBy,
    publicId: image.publicId,
    secureUrl: image.url,
    resourceType: 'image',
    format: image.format,
    bytes: image.bytes,
  });
  return image;
};
