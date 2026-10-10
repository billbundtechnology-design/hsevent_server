import { createHash, randomBytes, randomUUID } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { Booking } from '../models/booking.model.js';
import { Business } from '../models/business.model.js';
import { Customer } from '../models/customer.model.js';
import { InventoryAllocation } from '../models/inventory-allocation.model.js';
import { Listing } from '../models/listing.model.js';
import { VenueBlackout } from '../models/venue-blackout.model.js';
import { AuditEvent } from '../models/audit-event.model.js';
import { Payment } from '../models/payment.model.js';
import { Dispatch } from '../models/dispatch.model.js';
import { NotificationOutbox } from '../models/notification-outbox.model.js';
import type { RequestAuthContext } from '../auth/auth.types.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/http-error.js';
import {
  calculateBookingAmounts,
  calculateCancellationImpact,
  startedRentalPeriods,
} from './booking-pricing.js';

export interface BookingInput {
  customer?: { name: string; email?: string; phone?: string };
  customerId?: string;
  eventName: string;
  businessArm: 'rentals' | 'planning' | 'venue';
  eventDate: string;
  startAt?: string;
  endAt?: string;
  venueId?: string | null;
  guestCount?: number;
  deliveryAddress?: string;
  items: Array<{ listingId: string; quantity: number }>;
  notes?: string;
  discountPercent?: number;
}

interface BookingListInput {
  q?: string;
  status?: 'pending' | 'confirmed' | 'completed' | 'cancelled';
  businessArm?: 'rentals' | 'planning' | 'venue';
  customerId?: string;
  from?: string;
  to?: string;
  venueId?: string;
  page: number;
  pageSize: number;
}

const hashValue = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const publicAccessToken = (businessId: string, idempotencyKey: string): string =>
  createHash('sha256')
    .update(`${env.JWT_SECRET}:${businessId}:${idempotencyKey}`)
    .digest('hex');

const generateReference = (): string =>
  `RNT-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;

const normalizePhone = (phone?: string): string | null =>
  phone?.replace(/[\s()-]/g, '') ?? null;

const problem = (status: number, code: string, detail: string): AppError =>
  new AppError(status, code, detail);

const runTransaction = async <T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
  } finally {
    await session.endSession();
  }
  if (result === undefined) throw new Error('Booking transaction completed without a result.');
  return result;
};

const queueBookingNotification = async (
  booking: {
    id: string;
    businessId: string;
    reference: string;
    customerSnapshot?: { name: string; email?: string | null; phone?: string | null } | null;
    eventName: string;
    eventDate: string;
    status: string;
    totalKobo: number;
    currency: string;
    version: number;
  },
  type: 'booking.created' | 'booking.updated' | 'booking.confirmed' | 'booking.cancelled' | 'booking.completed',
  session: ClientSession,
): Promise<boolean> => {
  const customer = booking.customerSnapshot;
  if (!customer?.email && !customer?.phone) return false;
  const business = await Business.findOne({ id: booking.businessId })
    .select('notifications.bookingRequests')
    .session(session)
    .lean();
  if (business?.notifications?.bookingRequests === false) return false;
  await NotificationOutbox.create(
    [{
      id: randomUUID(),
      dedupeKey: `${booking.id}:${booking.version}:${type}`,
      businessId: booking.businessId,
      type,
      recipient: {
        name: customer.name,
        email: customer.email ?? null,
        phone: customer.phone ?? null,
      },
      payload: {
        bookingId: booking.id,
        reference: booking.reference,
        eventName: booking.eventName,
        eventDate: booking.eventDate,
        status: booking.status,
        totalKobo: booking.totalKobo,
        currency: booking.currency,
      },
      status: 'queued',
      nextAttemptAt: new Date(),
    }],
    { session },
  );
  return true;
};

const resolveCustomer = async (
  businessId: string,
  input: BookingInput,
  session: ClientSession,
) => {
  if (input.customerId) {
    const customer = await Customer.findOne({
      id: input.customerId,
      businessId,
      archivedAt: null,
    }).session(session);
    if (!customer) throw problem(404, 'NOT_FOUND', 'Customer was not found.');
    return customer;
  }

  const details = input.customer;
  if (!details) throw problem(422, 'VALIDATION_ERROR', 'Customer details are required.');
  const selectors: Record<string, string>[] = [];
  if (details.email) selectors.push({ email: details.email.toLowerCase() });
  const phone = normalizePhone(details.phone) ?? undefined;
  if (phone) selectors.push({ phone });

  if (selectors.length) {
    const matches = await Customer.find({
      businessId,
      archivedAt: null,
      $or: selectors,
    }).session(session);
    if (matches.length > 1) {
      throw problem(
        409,
        'CUSTOMER_MATCH_AMBIGUOUS',
        'The supplied contact details match multiple customer records.',
      );
    }
    const existing = matches[0];
    if (existing) {
      if (
        (details.email && existing.email && existing.email !== details.email.toLowerCase()) ||
        (phone && existing.phone && existing.phone !== phone)
      ) {
        throw problem(
          409,
          'CUSTOMER_CONTACT_CONFLICT',
          'The supplied contact details do not match the existing customer record.',
        );
      }
      return existing;
    }
  }

  const [customer] = await Customer.create(
    [{
      id: randomUUID(),
      businessId,
      name: details.name,
      email: details.email?.toLowerCase() ?? null,
      phone,
      type: 'private',
    }],
    { session },
  );
  if (!customer) throw new Error('Customer creation failed.');
  return customer;
};

const resolveLines = async (
  businessId: string,
  input: BookingInput,
  session: ClientSession,
  publicRequest: boolean,
) => {
  const requestedIds = [...new Set(input.items.map((item) => item.listingId))];
  const listings = await Listing.find({
    businessId,
    id: { $in: requestedIds },
    active: true,
    ...(publicRequest ? { published: true } : {}),
  }).session(session);
  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  if (byId.size !== requestedIds.length) {
    throw problem(422, 'INVALID_LISTING', 'One or more listings are unavailable.');
  }

  let subtotalKobo = 0;
  const lines = input.items.map((item) => {
    const listing = byId.get(item.listingId);
    if (!listing) throw problem(422, 'INVALID_LISTING', 'One or more listings are unavailable.');
    const allowedArm =
      (input.businessArm === 'rentals' && listing.kind === 'rental') ||
      (input.businessArm === 'planning' && listing.kind === 'planning') ||
      (input.businessArm === 'venue' && ['rental', 'venue', 'planning'].includes(listing.kind));
    if (!allowedArm) {
      throw problem(422, 'INVALID_BUSINESS_ARM', 'A listing is incompatible with the booking business arm.');
    }
    if (listing.kind === 'planning' && item.quantity !== 1) {
      throw problem(422, 'INVALID_QUANTITY', 'Planning services must have quantity one.');
    }
    if (listing.kind === 'venue' && item.quantity !== 1) {
      throw problem(422, 'INVALID_QUANTITY', 'Venue listings must have quantity one.');
    }
    if (
      (listing.kind === 'rental' || listing.kind === 'venue') &&
      (!input.startAt || !input.endAt)
    ) {
      throw problem(
        422,
        'BOOKING_INTERVAL_REQUIRED',
        'Rental and venue listings require startAt and endAt.',
      );
    }
    if (listing.kind === 'venue' && input.guestCount && listing.capacity && input.guestCount > listing.capacity) {
      throw problem(422, 'VENUE_CAPACITY_EXCEEDED', 'Guest count exceeds the venue capacity.');
    }
    const rentalPeriods = listing.kind === 'rental' && input.startAt && input.endAt
      ? startedRentalPeriods(new Date(input.startAt), new Date(input.endAt))
      : 1;
    const lineTotalKobo = listing.priceKobo * item.quantity * rentalPeriods;
    if (!Number.isSafeInteger(lineTotalKobo)) {
      throw problem(422, 'INVALID_TOTAL', 'Booking total exceeds the supported amount.');
    }
    subtotalKobo += lineTotalKobo;
    return {
      id: randomUUID(),
      listingId: listing.id,
      nameSnapshot: listing.name,
      kind: listing.kind,
      quantity: item.quantity,
      unitPriceKobo: listing.priceKobo,
      lineTotalKobo,
      rentalPeriods,
      rentalStartAt: input.startAt ? new Date(input.startAt) : null,
      rentalEndAt: input.endAt ? new Date(input.endAt) : null,
    };
  });
  if (!Number.isSafeInteger(subtotalKobo)) {
    throw problem(422, 'INVALID_TOTAL', 'Booking total exceeds the supported amount.');
  }
  if (input.businessArm === 'venue' && !lines.some((line) => line.kind === 'venue')) {
    throw problem(422, 'VENUE_REQUIRED', 'Venue bookings require an active venue listing.');
  }
  return { lines, subtotalKobo };
};

const createPendingBooking = async (
  businessId: string,
  input: BookingInput,
  options: {
    idempotencyKey?: string;
    createdBy?: string;
    publicRequest?: boolean;
    requestId?: string;
    session?: ClientSession;
  } = {},
) => {
  if (options.idempotencyKey && (options.idempotencyKey.length < 16 || options.idempotencyKey.length > 128)) {
    throw problem(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Idempotency-Key must be between 16 and 128 characters.',
    );
  }
  const keyHash = options.idempotencyKey ? hashValue(options.idempotencyKey) : null;
  const payloadHash = keyHash ? hashValue(JSON.stringify(input)) : null;
  if (keyHash) {
    const prior = await Booking.findOne({ businessId, idempotencyKeyHash: keyHash })
      .select('+idempotencyPayloadHash')
      .session(options.session ?? null)
      .lean();
    if (prior) {
      if (prior.idempotencyPayloadHash !== payloadHash) {
        throw problem(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
      }
      const notificationQueued = await NotificationOutbox.exists({
        businessId,
        type: 'booking.created',
        'payload.bookingId': prior.id,
      }).session(options.session ?? null);
      return {
        booking: prior,
        notificationQueued: Boolean(notificationQueued),
        customerAccessToken: options.publicRequest && options.idempotencyKey
          ? publicAccessToken(businessId, options.idempotencyKey)
          : null,
        replayed: true,
      };
    }
  }

  const customerAccessToken = options.publicRequest && options.idempotencyKey
    ? publicAccessToken(businessId, options.idempotencyKey)
    : null;

  try {
    const createInSession = async (session: ClientSession) => {
      const business = await Business.findOne({ id: businessId }).session(session).lean();
      if (!business) throw problem(404, 'BUSINESS_NOT_FOUND', 'Business was not found.');
      const customer = await resolveCustomer(businessId, input, session);
      const normalizedInput = { ...input, items: [...input.items] };
      if (
        input.venueId &&
        !normalizedInput.items.some((item) => item.listingId === input.venueId)
      ) {
        normalizedInput.items.push({ listingId: input.venueId, quantity: 1 });
      }
      const { lines, subtotalKobo } = await resolveLines(
        businessId,
        normalizedInput,
        session,
        options.publicRequest ?? false,
      );
      const venueLine = lines.find((line) => line.kind === 'venue');
      if (input.venueId && venueLine && input.venueId !== venueLine.listingId) {
        throw problem(422, 'VENUE_MISMATCH', 'venueId must match the venue listing in items.');
      }
      const venueId = input.venueId ?? venueLine?.listingId ?? null;
      if (input.businessArm === 'venue' && !venueId) {
        throw problem(422, 'VENUE_REQUIRED', 'Venue bookings require a venueId.');
      }
      const discountPercent = options.publicRequest ? 0 : input.discountPercent ?? 0;
      const taxPercent = business.bookingPolicies?.taxPercent ?? 0;
      const depositPercent = business.bookingPolicies?.depositPercent ?? 0;
      const amounts = calculateBookingAmounts(
        subtotalKobo,
        discountPercent,
        taxPercent,
        depositPercent,
      );

      const [created] = await Booking.create(
        [{
          id: randomUUID(),
          reference: generateReference(),
          businessId,
          customerId: customer.id,
          customerSnapshot: {
            name: customer.name,
            email: customer.email,
            phone: customer.phone,
          },
          eventName: input.eventName,
          businessArm: input.businessArm,
          eventDate: input.eventDate,
          startAt: input.startAt ? new Date(input.startAt) : null,
          endAt: input.endAt ? new Date(input.endAt) : null,
          venueId,
          guestCount: input.guestCount ?? null,
          deliveryAddress: input.deliveryAddress ?? null,
          lines,
          subtotalKobo,
          discountKobo: amounts.discountKobo,
          discountPercent,
          taxKobo: amounts.taxKobo,
          taxPercent,
          totalKobo: amounts.totalKobo,
          requiredDepositKobo: amounts.requiredDepositKobo,
          paidKobo: 0,
          balanceKobo: amounts.totalKobo,
          notes: input.notes ?? null,
          customerAccessTokenHash: customerAccessToken ? hashValue(customerAccessToken) : null,
          idempotencyKeyHash: keyHash,
          idempotencyPayloadHash: payloadHash,
          createdBy: options.createdBy ?? null,
        }],
        { session },
      );
      if (!created) throw new Error('Booking creation failed.');
      await AuditEvent.create(
        [{
          businessId,
          actorId: options.createdBy ?? null,
          resourceType: 'booking',
          resourceId: created.id,
          action: 'booking.created',
          requestId: options.requestId ?? null,
          details: {
            status: 'pending',
            publicRequest: options.publicRequest ?? false,
            subtotalKobo,
            discountPercent,
            discountKobo: amounts.discountKobo,
            taxPercent,
            taxKobo: amounts.taxKobo,
            requiredDepositKobo: amounts.requiredDepositKobo,
            totalKobo: amounts.totalKobo,
          },
        }],
        { session },
      );
      const booking = created.toObject();
      const notificationQueued = await queueBookingNotification(booking, 'booking.created', session);
      return { booking, notificationQueued };
    };
    const created = options.session
      ? await createInSession(options.session)
      : await runTransaction(createInSession);
    return { ...created, customerAccessToken, replayed: false };
  } catch (error) {
    if (!options.session && keyHash && typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      const existing = await Booking.findOne({ businessId, idempotencyKeyHash: keyHash })
        .select('+idempotencyPayloadHash')
        .lean();
      if (existing) {
        if (existing.idempotencyPayloadHash !== payloadHash) {
          throw problem(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
        }
        const notificationQueued = await NotificationOutbox.exists({
          businessId,
          type: 'booking.created',
          'payload.bookingId': existing.id,
        });
        return {
          booking: existing,
          notificationQueued: Boolean(notificationQueued),
          customerAccessToken: options.publicRequest && options.idempotencyKey
            ? publicAccessToken(businessId, options.idempotencyKey)
            : null,
          replayed: true,
        };
      }
    }
    throw error;
  }
};

export const createAdminBooking = async (
  context: RequestAuthContext,
  input: BookingInput,
  idempotencyKey: string,
  requestId?: string,
) => {
  const result = await createPendingBooking(context.businessId, input, {
    idempotencyKey,
    createdBy: context.userId,
    requestId,
  });
  return { booking: result.booking, replayed: result.replayed };
};

export const createAdminBookingInSession = async (
  businessId: string,
  actorId: string,
  input: BookingInput,
  idempotencyKey: string,
  session: ClientSession,
  requestId?: string,
) => (await createPendingBooking(businessId, input, {
  idempotencyKey,
  createdBy: actorId,
  requestId,
  session,
})).booking;

export const updatePendingBooking = async (
  businessId: string,
  id: string,
  input: BookingInput & { version: number },
  actorId: string,
  requestId?: string,
) => runTransaction(async (session) => {
  const booking = await Booking.findOne({
    businessId,
    id,
    version: input.version,
  }).session(session);
  if (!booking) {
    const current = await Booking.findOne({ businessId, id }).session(session);
    if (!current) throw problem(404, 'NOT_FOUND', 'Booking was not found.');
    if (current.status !== 'pending') {
      throw problem(409, 'INVALID_BOOKING_STATE', 'Only pending bookings can be edited.');
    }
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'The booking changed; reload and retry.',
      undefined,
      { ETag: `W/"${current.version}"` },
    );
  }
  if (booking.status !== 'pending') {
    throw problem(409, 'INVALID_BOOKING_STATE', 'Only pending bookings can be edited.');
  }
  if (await Payment.exists({ businessId, bookingId: id, status: 'succeeded' }).session(session)) {
    throw problem(409, 'BOOKING_HAS_PAYMENTS', 'A booking cannot be repriced after a payment has been recorded.');
  }

  const business = await Business.findOne({ id: businessId }).session(session).lean();
  if (!business) throw problem(404, 'BUSINESS_NOT_FOUND', 'Business was not found.');
  const customer = await resolveCustomer(businessId, input, session);
  const normalizedInput = { ...input, items: [...input.items] };
  if (
    input.venueId &&
    !normalizedInput.items.some((item) => item.listingId === input.venueId)
  ) {
    normalizedInput.items.push({ listingId: input.venueId, quantity: 1 });
  }
  const { lines, subtotalKobo } = await resolveLines(
    businessId,
    normalizedInput,
    session,
    false,
  );
  const venueLine = lines.find((line) => line.kind === 'venue');
  if (input.venueId && venueLine && input.venueId !== venueLine.listingId) {
    throw problem(422, 'VENUE_MISMATCH', 'venueId must match the venue listing in items.');
  }
  const venueId = input.venueId ?? venueLine?.listingId ?? null;
  if (input.businessArm === 'venue' && !venueId) {
    throw problem(422, 'VENUE_REQUIRED', 'Venue bookings require a venueId.');
  }
  const discountPercent = input.discountPercent ?? booking.discountPercent;
  const taxPercent = business.bookingPolicies?.taxPercent ?? 0;
  const depositPercent = business.bookingPolicies?.depositPercent ?? 0;
  const amounts = calculateBookingAmounts(subtotalKobo, discountPercent, taxPercent, depositPercent);
  if (amounts.totalKobo < booking.paidKobo) {
    throw problem(
      409,
      'TOTAL_BELOW_PAID_AMOUNT',
      'The revised total cannot be less than the amount already paid.',
    );
  }

  booking.customerId = customer.id;
  booking.customerSnapshot = {
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
  };
  booking.eventName = input.eventName;
  booking.businessArm = input.businessArm;
  booking.eventDate = input.eventDate;
  booking.startAt = input.startAt ? new Date(input.startAt) : null;
  booking.endAt = input.endAt ? new Date(input.endAt) : null;
  booking.venueId = venueId;
  booking.guestCount = input.guestCount ?? null;
  booking.deliveryAddress = input.deliveryAddress ?? null;
  booking.set('lines', lines);
  booking.subtotalKobo = subtotalKobo;
  booking.discountPercent = discountPercent;
  booking.discountKobo = amounts.discountKobo;
  booking.taxPercent = taxPercent;
  booking.taxKobo = amounts.taxKobo;
  booking.totalKobo = amounts.totalKobo;
  booking.requiredDepositKobo = amounts.requiredDepositKobo;
  booking.balanceKobo = amounts.totalKobo - booking.paidKobo;
  booking.paymentStatus =
    booking.paidKobo === 0 ? 'unpaid' : booking.paidKobo >= amounts.totalKobo ? 'paid' : 'part_paid';
  booking.notes = input.notes ?? null;
  booking.version += 1;
  await booking.save({ session });
  await AuditEvent.create(
    [{
      businessId,
      actorId,
      resourceType: 'booking',
      resourceId: booking.id,
      action: 'booking.updated',
      requestId: requestId ?? null,
      details: {
        version: booking.version,
        subtotalKobo,
        discountPercent,
        discountKobo: amounts.discountKobo,
        taxPercent,
        taxKobo: amounts.taxKobo,
        requiredDepositKobo: amounts.requiredDepositKobo,
        totalKobo: amounts.totalKobo,
      },
    }],
    { session },
  );
  const updated = booking.toObject();
  await queueBookingNotification(updated, 'booking.updated', session);
  return updated;
});

export const createPublicBookingRequest = async (
  input: BookingInput,
  idempotencyKey: string,
  requestId?: string,
) => {
  if (!env.PUBLIC_BUSINESS_ID) {
    throw problem(503, 'PUBLIC_STOREFRONT_NOT_CONFIGURED', 'The public storefront business is not configured.');
  }
  const business = await Business.findOne({ id: env.PUBLIC_BUSINESS_ID }).lean();
  if (!business) throw problem(503, 'PUBLIC_STOREFRONT_NOT_CONFIGURED', 'The public storefront business is not configured.');

  const result = await createPendingBooking(business.id, input, {
    idempotencyKey,
    publicRequest: true,
    requestId,
  });
  return {
    requestId: result.booking.id,
    reference: result.booking.reference,
    status: result.booking.status,
    totalKobo: result.booking.totalKobo,
    requiredDepositKobo: result.booking.requiredDepositKobo,
    currency: result.booking.currency,
    notificationQueued: result.notificationQueued,
    accessToken: result.customerAccessToken,
    replayed: result.replayed,
  };
};

export const getPublicBookingRequest = async (id: string, token: string) => {
  const booking = await Booking.findOne({
    id,
    customerAccessTokenHash: hashValue(token),
  }).lean();
  if (!booking) throw problem(404, 'NOT_FOUND', 'Booking request was not found.');
  return {
    requestId: booking.id,
    reference: booking.reference,
    status: booking.status,
    eventDate: booking.eventDate,
    eventName: booking.eventName,
    totalKobo: booking.totalKobo,
    requiredDepositKobo: booking.requiredDepositKobo,
    currency: booking.currency,
    createdAt: booking.createdAt,
  };
};

export const listBookings = async (businessId: string, input: BookingListInput) => {
  const filter: Record<string, unknown> = { businessId };
  if (input.status) filter.status = input.status;
  if (input.businessArm) filter.businessArm = input.businessArm;
  if (input.customerId) filter.customerId = input.customerId;
  if (input.venueId) filter.venueId = input.venueId;
  if (input.from || input.to) {
    const eventDate: Record<string, string> = {};
    if (input.from) eventDate.$gte = input.from;
    if (input.to) eventDate.$lte = input.to;
    filter.eventDate = eventDate;
  }
  if (input.q) {
    const escaped = input.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    filter.$or = [
      { reference: regex },
      { eventName: regex },
      { 'customerSnapshot.name': regex },
      { 'customerSnapshot.email': regex },
    ];
  }
  const [data, total] = await Promise.all([
    Booking.find(filter)
      .sort({ createdAt: -1, id: 1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean(),
    Booking.countDocuments(filter),
  ]);
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

export const getBooking = async (businessId: string, id: string) => {
  const booking = await Booking.findOne({ businessId, id }).lean();
  if (!booking) throw problem(404, 'NOT_FOUND', 'Booking was not found.');
  return booking;
};

export const listCustomerBookings = async (
  businessId: string,
  customerId: string,
  page: number,
  pageSize: number,
) => {
  const customer = await Customer.findOne({ businessId, id: customerId }).select('id').lean();
  if (!customer) throw problem(404, 'NOT_FOUND', 'Customer was not found.');
  const filter = { businessId, customerId };
  const [data, total] = await Promise.all([
    Booking.find(filter)
      .sort({ createdAt: -1, id: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .select('id reference eventName eventDate status paymentStatus totalKobo balanceKobo currency createdAt')
      .lean(),
    Booking.countDocuments(filter),
  ]);
  return {
    data,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
};

export const confirmBooking = async (
  businessId: string,
  id: string,
  actorId: string,
  requestId?: string,
) =>
  runTransaction(async (session) => {
    const booking = await Booking.findOne({ businessId, id }).session(session);
    if (!booking) throw problem(404, 'NOT_FOUND', 'Booking was not found.');
    if (booking.status !== 'pending') {
      throw problem(409, 'INVALID_BOOKING_STATE', 'Only pending bookings can be confirmed.');
    }
    if (booking.paidKobo < booking.requiredDepositKobo) {
      throw new AppError(
        409,
        'DEPOSIT_REQUIRED',
        'The required booking deposit must be recorded before confirmation.',
        undefined,
        {
          'X-Required-Deposit-Kobo': String(booking.requiredDepositKobo),
          'X-Paid-Kobo': String(booking.paidKobo),
          'X-Deposit-Balance-Kobo': String(booking.requiredDepositKobo - booking.paidKobo),
        },
      );
    }

    const allocationsToCreate: Array<Record<string, unknown>> = [];
    const rentalLines = booking.lines.filter((line) => line.kind === 'rental');
    for (const line of rentalLines) {
      if (!booking.startAt || !booking.endAt) {
        throw problem(422, 'BOOKING_INTERVAL_REQUIRED', 'Rental bookings require startAt and endAt.');
      }
      const bookingStartAt = booking.startAt;
      const bookingEndAt = booking.endAt;
      const listing = await Listing.findOne({
        businessId,
        id: line.listingId,
        active: true,
      }).session(session);
      if (!listing || listing.totalUnits === null || listing.totalUnits === undefined) {
        throw problem(409, 'AVAILABILITY_CONFLICT', 'Rental stock is not available for this booking.');
      }

      const activeAllocations = await InventoryAllocation.find({
        businessId,
        listingId: line.listingId,
        status: 'active',
        startAt: { $lt: bookingEndAt },
        endAt: { $gt: bookingStartAt },
      }).session(session).lean();
      const allocationEvents = activeAllocations
        .flatMap((allocation) => [
          {
            time: Math.max(allocation.startAt.getTime(), bookingStartAt.getTime()),
            quantity: allocation.quantity,
          },
          {
            time: Math.min(allocation.endAt.getTime(), bookingEndAt.getTime()),
            quantity: -allocation.quantity,
          },
        ])
        .sort((left, right) => left.time - right.time || left.quantity - right.quantity);
      let allocated = 0;
      let peakAllocated = 0;
      for (const event of allocationEvents) {
        allocated += event.quantity;
        peakAllocated = Math.max(peakAllocated, allocated);
      }
      const available = listing.totalUnits - listing.damagedUnits - listing.missingUnits - peakAllocated;
      if (available < line.quantity) {
        throw problem(409, 'AVAILABILITY_CONFLICT', 'There is not enough stock available for this booking.');
      }
      const lock = await Listing.updateOne(
        { id: listing.id, businessId, allocationVersion: listing.allocationVersion },
        { $inc: { allocationVersion: 1 } },
        { session },
      );
      if (lock.modifiedCount !== 1) {
        throw problem(409, 'AVAILABILITY_CONFLICT', 'Stock availability changed; retry confirmation.');
      }
      allocationsToCreate.push({
        id: randomUUID(),
        businessId,
        bookingId: booking.id,
        listingId: line.listingId,
        quantity: line.quantity,
        startAt: bookingStartAt,
        endAt: bookingEndAt,
        status: 'active',
      });
    }

    const venueLines = booking.lines.filter((line) => line.kind === 'venue');
    for (const line of venueLines) {
      if (!booking.startAt || !booking.endAt) {
        throw problem(422, 'BOOKING_INTERVAL_REQUIRED', 'Venue bookings require startAt and endAt.');
      }
      const venue = await Listing.findOne({
        businessId,
        id: line.listingId,
        kind: 'venue',
        active: true,
        status: 'available',
      }).session(session);
      if (!venue || (venue.capacity !== null && venue.capacity !== undefined && booking.guestCount !== null && booking.guestCount !== undefined && booking.guestCount > venue.capacity)) {
        throw problem(409, 'AVAILABILITY_CONFLICT', 'The venue is unavailable or cannot accommodate this booking.');
      }
      const reservationStartAt = new Date(
        booking.startAt.getTime() - (venue.bufferBeforeMinutes ?? 0) * 60_000,
      );
      const reservationEndAt = new Date(
        booking.endAt.getTime() + (venue.bufferAfterMinutes ?? 0) * 60_000,
      );
      const blackout = await VenueBlackout.exists({
        businessId,
        venueId: venue.id,
        startAt: { $lt: reservationEndAt },
        endAt: { $gt: reservationStartAt },
      }).session(session);
      if (blackout) {
        throw problem(409, 'AVAILABILITY_CONFLICT', 'The venue is unavailable during a blackout.');
      }
      const conflict = await InventoryAllocation.exists({
        businessId,
        listingId: venue.id,
        status: 'active',
        startAt: { $lt: reservationEndAt },
        endAt: { $gt: reservationStartAt },
      }).session(session);
      if (conflict) throw problem(409, 'AVAILABILITY_CONFLICT', 'The venue is already booked for this interval.');
      const lock = await Listing.updateOne(
        { id: venue.id, businessId, allocationVersion: venue.allocationVersion },
        { $inc: { allocationVersion: 1 } },
        { session },
      );
      if (lock.modifiedCount !== 1) {
        throw problem(409, 'AVAILABILITY_CONFLICT', 'Venue availability changed; retry confirmation.');
      }
      allocationsToCreate.push({
        id: randomUUID(),
        businessId,
        bookingId: booking.id,
        listingId: line.listingId,
        quantity: 1,
        startAt: booking.startAt,
        endAt: booking.endAt,
        status: 'active',
      });
    }

    if (allocationsToCreate.length) {
      await InventoryAllocation.insertMany(allocationsToCreate, { session });
    }
    booking.status = 'confirmed';
    booking.version += 1;
    await booking.save({ session });
    await AuditEvent.create(
      [{
        businessId,
        actorId,
        resourceType: 'booking',
        resourceId: booking.id,
        action: 'booking.confirmed',
        requestId: requestId ?? null,
        details: { status: 'confirmed' },
      }],
      { session },
    );
    const confirmed = booking.toObject();
    await queueBookingNotification(confirmed, 'booking.confirmed', session);
    return confirmed;
  });

const cancellationImpactFor = (
  booking: {
    eventDate: string;
    startAt?: Date | null;
    paidKobo: number;
  },
  policy: {
    cancellationCutoffHours?: number;
    refundPercentBeforeCutoff?: number;
    refundPercentAfterCutoff?: number;
  },
  now: Date,
) => calculateCancellationImpact(
  booking,
  {
    cancellationCutoffHours: policy.cancellationCutoffHours ?? 0,
    refundPercentBeforeCutoff: policy.refundPercentBeforeCutoff ?? 100,
    refundPercentAfterCutoff: policy.refundPercentAfterCutoff ?? 0,
  },
  now,
);

export const getBookingCancellationPreview = async (businessId: string, id: string) => {
  const [booking, business] = await Promise.all([
    Booking.findOne({ businessId, id }).lean(),
    Business.findOne({ id: businessId }).select('bookingPolicies').lean(),
  ]);
  if (!booking) throw problem(404, 'NOT_FOUND', 'Booking was not found.');
  if (!business) throw problem(404, 'BUSINESS_NOT_FOUND', 'Business was not found.');
  if (!['pending', 'confirmed'].includes(booking.status)) {
    throw problem(409, 'INVALID_BOOKING_STATE', 'Only pending or confirmed bookings can be cancelled.');
  }
  if (await Dispatch.exists({
    businessId,
    bookingId: id,
    status: { $in: ['dispatched', 'partially_returned', 'returned'] },
  })) {
    throw problem(409, 'DISPATCH_ALREADY_STARTED', 'A booking cannot be cancelled after rental items have been dispatched.');
  }
  return {
    bookingId: booking.id,
    version: booking.version,
    reasonRequired: true,
    ...cancellationImpactFor(booking, business.bookingPolicies ?? {}, new Date()),
  };
};

export const cancelBooking = async (
  businessId: string,
  id: string,
  reason: string,
  version: number,
  actorId: string,
  requestId?: string,
) => runTransaction(async (session) => {
  const booking = await Booking.findOne({ businessId, id }).session(session);
  if (!booking) throw problem(404, 'NOT_FOUND', 'Booking was not found.');
  if (booking.version !== version) {
    throw new AppError(409, 'VERSION_CONFLICT', 'The booking changed; preview cancellation again.', undefined, {
      ETag: `W/"${booking.version}"`,
    });
  }
  if (!['pending', 'confirmed'].includes(booking.status)) {
    throw problem(409, 'INVALID_BOOKING_STATE', 'Only pending or confirmed bookings can be cancelled.');
  }
  const business = await Business.findOne({ id: businessId }).select('bookingPolicies').session(session).lean();
  if (!business) throw problem(404, 'BUSINESS_NOT_FOUND', 'Business was not found.');
  const cancellation = cancellationImpactFor(booking, business.bookingPolicies ?? {}, new Date());
  const dispatch = await Dispatch.findOne({ businessId, bookingId: id }).session(session);
  if (dispatch && ['dispatched', 'partially_returned', 'returned'].includes(dispatch.status)) {
    throw problem(409, 'DISPATCH_ALREADY_STARTED', 'A booking cannot be cancelled after rental items have been dispatched.');
  }
  if (dispatch) {
    dispatch.status = 'cancelled';
    dispatch.version += 1;
    await dispatch.save({ session });
    await AuditEvent.create(
      [{
        businessId,
        actorId,
        resourceType: 'dispatch',
        resourceId: dispatch.id,
        action: 'dispatch.cancelled_with_booking',
        requestId: requestId ?? null,
        details: { reason: 'Parent booking cancelled.' },
      }],
      { session },
    );
  }
  booking.status = 'cancelled';
  booking.cancellationReason = reason;
  booking.version += 1;
  await booking.save({ session });
  await AuditEvent.create(
    [{
      businessId,
      actorId,
      resourceType: 'booking',
      resourceId: booking.id,
      action: 'booking.cancelled',
      requestId: requestId ?? null,
      details: { reason, cancellation },
    }],
    { session },
  );
  await InventoryAllocation.updateMany(
    { businessId, bookingId: id, status: 'active' },
    { $set: { status: 'released' } },
    { session },
  );
  const cancelled = booking.toObject();
  await queueBookingNotification(cancelled, 'booking.cancelled', session);
  return { booking: cancelled, cancellation };
});

export const completeBooking = async (
  businessId: string,
  id: string,
  actorId: string,
  requestId?: string,
) =>
  runTransaction(async (session) => {
    const booking = await Booking.findOne({ businessId, id }).session(session);
    if (!booking) throw problem(404, 'NOT_FOUND', 'Booking was not found.');
    if (booking.status !== 'confirmed') {
      throw problem(409, 'INVALID_BOOKING_STATE', 'Only confirmed bookings can be completed.');
    }
    const dispatch = await Dispatch.findOne({ businessId, bookingId: id }).session(session);
    const hasRentalItems = booking.lines.some((line) => line.kind === 'rental');
    if (hasRentalItems && (!dispatch || dispatch.status !== 'returned')) {
      throw problem(409, 'RETURNS_NOT_RECONCILED', 'All dispatched rental items must be returned or recorded missing before completing this booking.');
    }
    booking.status = 'completed';
    booking.version += 1;
    await booking.save({ session });
    await AuditEvent.create(
      [{
        businessId,
        actorId,
        resourceType: 'booking',
        resourceId: booking.id,
        action: 'booking.completed',
        requestId: requestId ?? null,
        details: { status: 'completed' },
      }],
      { session },
    );
    await InventoryAllocation.updateMany(
      { businessId, bookingId: id, status: 'active' },
      { $set: { status: 'released' } },
      { session },
    );
    const completed = booking.toObject();
    await queueBookingNotification(completed, 'booking.completed', session);
    return completed;
  });

export const resolvePublicBusinessId = (): string => {
  if (!env.PUBLIC_BUSINESS_ID) {
    throw problem(503, 'PUBLIC_STOREFRONT_NOT_CONFIGURED', 'The public storefront business is not configured.');
  }
  return env.PUBLIC_BUSINESS_ID;
};
