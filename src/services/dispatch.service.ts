import { createHash, randomUUID } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { AppError } from '../middleware/http-error.js';
import { AuditEvent } from '../models/audit-event.model.js';
import { Booking } from '../models/booking.model.js';
import { Dispatch } from '../models/dispatch.model.js';
import { DispatchOperation } from '../models/dispatch-operation.model.js';
import { InventoryAllocation } from '../models/inventory-allocation.model.js';
import { Listing } from '../models/listing.model.js';
import { Membership } from '../models/membership.model.js';
import { StockMovement } from '../models/stock-movement.model.js';

interface DispatchListInput {
  status?: 'scheduled' | 'preparing' | 'dispatched' | 'partially_returned' | 'returned' | 'cancelled' | 'overdue';
  from?: string;
  to?: string;
  bookingId?: string;
  assignedStaffId?: string;
  page: number;
  pageSize: number;
}

interface OperationContext {
  businessId: string;
  dispatchId: string;
  operation: 'created' | 'checklist' | 'dispatched' | 'returned';
  key: string;
  payload: unknown;
  actorId: string;
  requestId: string;
}

const notFound = (): AppError => new AppError(404, 'NOT_FOUND', 'Dispatch was not found.');
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};
const stableJson = (value: unknown): string => JSON.stringify(canonicalize(value));
const makeReference = (): string =>
  `DSP-${Date.now().toString(36).toUpperCase()}-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;

const assertActiveStaff = async (businessId: string, staffIds: string[], session: ClientSession) => {
  if (!staffIds.length) return;
  const count = await Membership.countDocuments({
    businessId,
    id: { $in: staffIds },
    status: 'active',
  }).session(session);
  if (count !== new Set(staffIds).size) {
    throw new AppError(422, 'INVALID_ASSIGNEE', 'Every assigned staff member must have an active membership in this business.');
  }
};

const runOperation = async <T>(
  context: OperationContext,
  work: (session: ClientSession) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> => {
  const keyHash = hash(`${context.businessId}:${context.key}`);
  const payloadHash = hash(stableJson({ operation: context.operation, dispatchId: context.dispatchId, payload: context.payload }));
  const existing = await DispatchOperation.findOne({ businessId: context.businessId, idempotencyKeyHash: keyHash }).lean();
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with different dispatch details.');
    }
    return { result: existing.result as T, replayed: true };
  }

  try {
    const result = await mongoose.connection.transaction(async (session) => {
      const output = await work(session);
      await DispatchOperation.create(
        [{
          businessId: context.businessId,
          dispatchId: context.dispatchId,
          operation: context.operation,
          idempotencyKeyHash: keyHash,
          payloadHash,
          result: output,
          actorId: context.actorId,
          requestId: context.requestId,
        }],
        { session },
      );
      return output;
    });
    return { result, replayed: false };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      const raced = await DispatchOperation.findOne({ businessId: context.businessId, idempotencyKeyHash: keyHash }).lean();
      if (raced) {
        if (raced.payloadHash !== payloadHash) {
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with different dispatch details.');
        }
        return { result: raced.result as T, replayed: true };
      }
    }
    throw error;
  }
};

const publicDispatchStatus = (dispatch: {
  status: string;
  expectedReturnAt: Date;
  items: Array<{ expectedQuantity: number; returnedQuantity: number; missingQuantity: number }>;
}) => {
  if (
    ['dispatched', 'partially_returned'].includes(dispatch.status) &&
    dispatch.expectedReturnAt.getTime() < Date.now() &&
    dispatch.items.some((item) => item.returnedQuantity + item.missingQuantity < item.expectedQuantity)
  ) {
    return 'overdue';
  }
  return dispatch.status;
};

const toDispatch = (dispatch: Record<string, unknown>) => ({
  ...dispatch,
  status: publicDispatchStatus(dispatch as never),
});

export const listDispatches = async (businessId: string, input: DispatchListInput) => {
  const filter: Record<string, unknown> = { businessId };
  if (input.bookingId) filter.bookingId = input.bookingId;
  if (input.assignedStaffId) filter.assignedStaffIds = input.assignedStaffId;
  if (input.from || input.to) {
    filter.scheduledAt = {
      ...(input.from ? { $gte: new Date(input.from) } : {}),
      ...(input.to ? { $lte: new Date(input.to) } : {}),
    };
  }
  if (input.status === 'overdue') {
    filter.status = { $in: ['dispatched', 'partially_returned'] };
    filter.expectedReturnAt = { $lt: new Date() };
    filter.$expr = {
      $anyElementTrue: [{
        $map: {
          input: '$items',
          as: 'item',
          in: { $lt: [{ $add: ['$$item.returnedQuantity', '$$item.missingQuantity'] }, '$$item.expectedQuantity'] },
        },
      }],
    };
  } else if (input.status) {
    filter.status = input.status;
  }

  const [records, total] = await Promise.all([
    Dispatch.find(filter)
      .sort({ scheduledAt: 1, id: 1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean(),
    Dispatch.countDocuments(filter),
  ]);
  return {
    data: records.map(toDispatch),
    meta: { page: input.page, pageSize: input.pageSize, total, totalPages: Math.ceil(total / input.pageSize) },
  };
};

export const createDispatch = async (
  businessId: string,
  bookingId: string,
  actorId: string,
  requestId: string,
  idempotencyKey: string,
  input: {
    scheduledAt?: string;
    expectedReturnAt?: string;
    deliveryAddress?: string | null;
    assignedStaffIds: string[];
    internalNotes?: string | null;
  },
) => {
  const dispatchId = randomUUID();
  try {
    const operation = await runOperation(
    { businessId, dispatchId: bookingId, operation: 'created', key: idempotencyKey, payload: { bookingId, input }, actorId, requestId },
    async (session) => {
      const booking = await Booking.findOne({ businessId, id: bookingId }).session(session);
      if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found.');
      if (booking.status !== 'confirmed') {
        throw new AppError(409, 'BOOKING_NOT_CONFIRMED', 'A dispatch plan requires a confirmed booking.');
      }
      if (await Dispatch.exists({ businessId, bookingId }).session(session)) {
        throw new AppError(409, 'DISPATCH_EXISTS', 'A dispatch plan already exists for this booking.');
      }
      const rentalLines = booking.lines.filter((line) => line.kind === 'rental');
      if (!rentalLines.length) {
        throw new AppError(422, 'NO_RENTAL_ITEMS', 'Dispatch plans require at least one rental item.');
      }
      await assertActiveStaff(businessId, input.assignedStaffIds, session);
      const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : booking.startAt;
      const expectedReturnAt = input.expectedReturnAt ? new Date(input.expectedReturnAt) : booking.endAt;
      if (!scheduledAt || !expectedReturnAt || expectedReturnAt <= scheduledAt) {
        throw new AppError(422, 'INVALID_DISPATCH_INTERVAL', 'Dispatch and expected return dates must form a valid interval.');
      }
      const allocations = await InventoryAllocation.find({
        businessId,
        bookingId,
        status: 'active',
      }).session(session).lean();
      const byListing = new Map(allocations.map((allocation) => [allocation.listingId, allocation]));
      const items = rentalLines.map((line) => {
        const allocation = byListing.get(line.listingId);
        if (!allocation || allocation.quantity !== line.quantity) {
          throw new AppError(409, 'ALLOCATION_MISMATCH', 'Confirmed rental allocations do not match booking quantities.');
        }
        return {
          listingId: line.listingId,
          bookingLineId: line.id,
          nameSnapshot: line.nameSnapshot,
          expectedQuantity: line.quantity,
          dispatchedQuantity: 0,
          returnedQuantity: 0,
          damagedQuantity: 0,
          missingQuantity: 0,
        };
      });
      const [dispatch] = await Dispatch.create(
        [{
          id: dispatchId,
          businessId,
          bookingId,
          reference: makeReference(),
          scheduledAt,
          expectedReturnAt,
          deliveryAddress: input.deliveryAddress ?? booking.deliveryAddress,
          assignedStaffIds: input.assignedStaffIds,
          internalNotes: input.internalNotes ?? null,
          status: 'scheduled',
          items,
          checklist: [],
          createdBy: actorId,
        }],
        { session },
      );
      if (!dispatch) throw new Error('Dispatch creation failed.');
      await AuditEvent.create(
        [{
          businessId,
          actorId,
          requestId,
          resourceType: 'dispatch',
          resourceId: dispatch.id,
          action: 'dispatch.created',
          details: { bookingId, itemCount: items.length },
        }],
        { session },
      );
      return dispatch.toObject();
    },
    );
    return { data: toDispatch(operation.result as Record<string, unknown>), replayed: operation.replayed };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      const existing = await Dispatch.findOne({ businessId, bookingId }).lean();
      if (existing) throw new AppError(409, 'DISPATCH_EXISTS', 'A dispatch plan already exists for this booking.');
    }
    throw error;
  }
};

export const getDispatch = async (businessId: string, id: string) => {
  const dispatch = await Dispatch.findOne({ businessId, id }).lean();
  if (!dispatch) throw notFound();
  const booking = await Booking.findOne({ businessId, id: dispatch.bookingId })
    .select('reference eventName eventDate startAt endAt status customerSnapshot deliveryAddress')
    .lean();
  return { ...toDispatch(dispatch), booking, version: dispatch.version };
};

export const updateDispatch = async (
  businessId: string,
  id: string,
  actorId: string,
  requestId: string,
  input: {
    scheduledAt?: string;
    expectedReturnAt?: string;
    deliveryAddress?: string | null;
    assignedStaffIds?: string[];
    internalNotes?: string | null;
    version: number;
  },
) => mongoose.connection.transaction(async (session) => {
  const current = await Dispatch.findOne({ businessId, id, version: input.version }).session(session);
  if (!current) {
    if (!(await Dispatch.exists({ businessId, id }).session(session))) throw notFound();
    throw new AppError(409, 'VERSION_CONFLICT', 'Dispatch changed; reload and retry.');
  }
  if (current.status === 'cancelled' || current.status === 'returned' || current.status === 'dispatched' || current.status === 'partially_returned') {
    throw new AppError(409, 'DISPATCH_LOCKED', 'Dispatch details can no longer be changed after dispatch or completion.');
  }
  if (input.assignedStaffIds) await assertActiveStaff(businessId, input.assignedStaffIds, session);
  const { version, ...updates } = input;
  const scheduledAt = updates.scheduledAt ? new Date(updates.scheduledAt) : current.scheduledAt;
  const expectedReturnAt = updates.expectedReturnAt ? new Date(updates.expectedReturnAt) : current.expectedReturnAt;
  if (expectedReturnAt <= scheduledAt) {
    throw new AppError(422, 'INVALID_DISPATCH_INTERVAL', 'Expected return must be after the dispatch schedule.');
  }
  Object.assign(current, {
    ...updates,
    scheduledAt,
    expectedReturnAt,
    status: current.status === 'scheduled' ? 'preparing' : current.status,
    version: current.version + 1,
  });
  await current.save({ session });
  await AuditEvent.create(
    [{
      businessId,
      actorId,
      requestId,
      resourceType: 'dispatch',
      resourceId: id,
      action: 'dispatch.updated',
      details: { version: current.version },
    }],
    { session },
  );
  return toDispatch(current.toObject() as unknown as Record<string, unknown>);
});

export const recordChecklist = async (
  businessId: string,
  id: string,
  actorId: string,
  requestId: string,
  idempotencyKey: string,
  input: { stage: 'preparation' | 'dispatch' | 'collection' | 'return'; itemKey: string; checked: boolean; note?: string },
) => runOperation(
  { businessId, dispatchId: id, operation: 'checklist', key: idempotencyKey, payload: input, actorId, requestId },
  async (session) => {
    const dispatch = await Dispatch.findOne({ businessId, id }).session(session);
    if (!dispatch) throw notFound();
    if (['returned', 'cancelled'].includes(dispatch.status)) {
      throw new AppError(409, 'DISPATCH_LOCKED', 'Checklist cannot be changed after dispatch completion or cancellation.');
    }
    const existing = dispatch.checklist.find((entry) => entry.stage === input.stage && entry.itemKey === input.itemKey);
    if (existing) {
      existing.checked = input.checked;
      existing.note = input.note ?? null;
      existing.checkedBy = actorId;
      existing.checkedAt = new Date();
    } else {
      dispatch.checklist.push({
        id: randomUUID(),
        ...input,
        note: input.note ?? null,
        checkedBy: actorId,
        checkedAt: new Date(),
      });
    }
    if (input.stage === 'preparation' && dispatch.status === 'scheduled') dispatch.status = 'preparing';
    dispatch.version += 1;
    await dispatch.save({ session });
    await AuditEvent.create(
      [{
        businessId,
        actorId,
        requestId,
        resourceType: 'dispatch',
        resourceId: id,
        action: 'dispatch.checklist_updated',
        details: { stage: input.stage, itemKey: input.itemKey, checked: input.checked },
      }],
      { session },
    );
    return dispatch.toObject();
  },
);

export const markDispatched = async (
  businessId: string,
  id: string,
  actorId: string,
  requestId: string,
  idempotencyKey: string,
  input: { dispatchedAt?: string; items: Array<{ listingId: string; quantity: number }> },
) => runOperation(
  { businessId, dispatchId: id, operation: 'dispatched', key: idempotencyKey, payload: input, actorId, requestId },
  async (session) => {
    const dispatch = await Dispatch.findOne({ businessId, id }).session(session);
    if (!dispatch) throw notFound();
    if (!['scheduled', 'preparing'].includes(dispatch.status)) {
      throw new AppError(409, 'INVALID_DISPATCH_STATE', 'Only a scheduled or preparing dispatch can be marked dispatched.');
    }
    const quantities = new Map(input.items.map((item) => [item.listingId, item.quantity]));
    if (quantities.size !== dispatch.items.length || dispatch.items.some((item) => !quantities.has(item.listingId))) {
      throw new AppError(422, 'DISPATCH_ITEMS_MISMATCH', 'Provide a dispatched quantity for every rental item.');
    }
    for (const item of dispatch.items) {
      const quantity = quantities.get(item.listingId);
      if (!quantity || quantity !== item.expectedQuantity) {
        throw new AppError(422, 'INVALID_DISPATCH_QUANTITY', 'Dispatched quantities must match the confirmed booking quantities.');
      }
      item.dispatchedQuantity = quantity;
    }
    dispatch.status = 'dispatched';
    dispatch.dispatchedAt = input.dispatchedAt ? new Date(input.dispatchedAt) : new Date();
    dispatch.version += 1;
    await dispatch.save({ session });
    await AuditEvent.create(
      [{
        businessId,
        actorId,
        requestId,
        resourceType: 'dispatch',
        resourceId: id,
        action: 'dispatch.marked_dispatched',
        details: { dispatchedAt: dispatch.dispatchedAt, items: input.items },
      }],
      { session },
    );
    return dispatch.toObject();
  },
);

export const markReturned = async (
  businessId: string,
  id: string,
  actorId: string,
  requestId: string,
  idempotencyKey: string,
  input: {
    returnedAt?: string;
    items: Array<{ listingId: string; returnedQuantity: number; damagedQuantity: number; missingQuantity: number }>;
  },
) => runOperation(
  { businessId, dispatchId: id, operation: 'returned', key: idempotencyKey, payload: input, actorId, requestId },
  async (session) => {
    const dispatch = await Dispatch.findOne({ businessId, id }).session(session);
    if (!dispatch) throw notFound();
    if (!['dispatched', 'partially_returned'].includes(dispatch.status)) {
      throw new AppError(409, 'INVALID_DISPATCH_STATE', 'Only dispatched items can be reconciled as returned.');
    }
    if (input.items.every((item) =>
      item.returnedQuantity === 0 && item.damagedQuantity === 0 && item.missingQuantity === 0,
    )) {
      throw new AppError(422, 'EMPTY_RECONCILIATION', 'At least one returned or missing quantity must be recorded.');
    }
    const quantities = new Map(input.items.map((item) => [item.listingId, item]));
    if (quantities.size !== dispatch.items.length || dispatch.items.some((item) => !quantities.has(item.listingId))) {
      throw new AppError(422, 'DISPATCH_ITEMS_MISMATCH', 'Provide a return reconciliation for every dispatched item.');
    }
    const movementWrites: Array<Record<string, unknown>> = [];
    for (const item of dispatch.items) {
      const reconciliation = quantities.get(item.listingId);
      if (!reconciliation) throw new Error('Missing validated item reconciliation.');
      const reconciledTotal =
        item.returnedQuantity + item.missingQuantity +
        reconciliation.returnedQuantity + reconciliation.missingQuantity;
      if (reconciledTotal > item.dispatchedQuantity) {
        throw new AppError(422, 'RETURN_QUANTITY_EXCEEDS_DISPATCH', 'Returned and missing quantities cannot exceed dispatched quantity.');
      }
      const newlyReconciled = reconciliation.returnedQuantity + reconciliation.missingQuantity;
      if (
        newlyReconciled === 0 &&
        reconciliation.damagedQuantity === 0 &&
        reconciliation.missingQuantity === 0
      ) {
        continue;
      }
      let remainingAllocation = item.dispatchedQuantity -
        (item.returnedQuantity + item.missingQuantity + newlyReconciled);
      const allocation = newlyReconciled
        ? await InventoryAllocation.findOne({
            businessId,
            bookingId: dispatch.bookingId,
            listingId: item.listingId,
            status: 'active',
          }).session(session)
        : null;
      if (newlyReconciled && (!allocation || allocation.quantity !== item.dispatchedQuantity - item.returnedQuantity - item.missingQuantity)) {
        throw new AppError(409, 'ALLOCATION_MISMATCH', 'Active stock allocation does not match the unreconciled dispatched quantity.');
      }
      if (allocation) {
        if (remainingAllocation === 0) {
          allocation.status = 'released';
        } else {
          allocation.quantity = remainingAllocation;
        }
        await allocation.save({ session });
      }
      item.returnedQuantity += reconciliation.returnedQuantity;
      item.damagedQuantity += reconciliation.damagedQuantity;
      item.missingQuantity += reconciliation.missingQuantity;
      const listing = await Listing.findOne({ businessId, id: item.listingId, kind: 'rental' })
        .session(session);
      if (!listing) throw new AppError(404, 'INVENTORY_ITEM_NOT_FOUND', 'A dispatched inventory item was not found.');
      const nextDamaged = (listing.damagedUnits ?? 0) + reconciliation.damagedQuantity;
      const nextMissing = (listing.missingUnits ?? 0) + reconciliation.missingQuantity;
      const totalUnits = listing.totalUnits ?? 0;
      if (nextDamaged + nextMissing > totalUnits) {
        throw new AppError(409, 'INVENTORY_CONDITION_CONFLICT', 'Returned condition counts exceed the inventory item total.');
      }
      const update = await Listing.updateOne(
        {
          businessId,
          id: item.listingId,
          kind: 'rental',
          version: listing.version,
          allocationVersion: listing.allocationVersion,
        },
        {
          $set: { damagedUnits: nextDamaged, missingUnits: nextMissing },
          $inc: { version: 1, allocationVersion: 1 },
        },
        { session },
      );
      if (update.modifiedCount !== 1) {
        throw new AppError(409, 'INVENTORY_CONFLICT', 'Inventory changed while the return was being reconciled.');
      }
      if (reconciliation.damagedQuantity || reconciliation.missingQuantity) {
        movementWrites.push({
          businessId,
          listingId: item.listingId,
          actorId,
          requestId,
          type: 'dispatch_return',
          quantityDelta: 0,
          damagedDelta: reconciliation.damagedQuantity,
          missingDelta: reconciliation.missingQuantity,
          totalUnitsAfter: totalUnits,
          damagedUnitsAfter: nextDamaged,
          missingUnitsAfter: nextMissing,
          reason: `Return reconciliation for dispatch ${dispatch.reference}`,
        });
      }
    }
    if (movementWrites.length) await StockMovement.insertMany(movementWrites, { session });
    const allReconciled = dispatch.items.every(
      (item) => item.returnedQuantity + item.missingQuantity === item.dispatchedQuantity,
    );
    dispatch.status = allReconciled ? 'returned' : 'partially_returned';
    dispatch.returnedAt = allReconciled
      ? (input.returnedAt ? new Date(input.returnedAt) : new Date())
      : null;
    dispatch.version += 1;
    await dispatch.save({ session });

    await AuditEvent.create(
      [{
        businessId,
        actorId,
        requestId,
        resourceType: 'dispatch',
        resourceId: id,
        action: allReconciled ? 'dispatch.marked_returned' : 'dispatch.partially_returned',
        details: { returnedAt: dispatch.returnedAt, items: input.items },
      }],
      { session },
    );
    return dispatch.toObject();
  },
);
