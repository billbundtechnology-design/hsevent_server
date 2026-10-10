import { randomBytes, randomUUID } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { AuditEvent } from '../models/audit-event.model.js';
import { Booking } from '../models/booking.model.js';
import { Enquiry } from '../models/enquiry.model.js';
import { Membership } from '../models/membership.model.js';
import { AppError } from '../middleware/http-error.js';
import { createAdminBookingInSession, type BookingInput } from './booking.service.js';

const enquiryReference = () =>
  `ENQ-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;

const notFound = () => new AppError(404, 'NOT_FOUND', 'Enquiry was not found.');

const runTransaction = async <T>(work: (session: ClientSession) => Promise<T>): Promise<T> => {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
  } finally {
    await session.endSession();
  }
  if (result === undefined) throw new Error('Enquiry transaction completed without a result.');
  return result;
};

export const createPublicEnquiry = async (
  businessId: string,
  input: {
    name: string;
    email?: string;
    phone?: string;
    eventType?: string;
    eventDate?: string;
    guestCount?: number;
    message: string;
    source?: string;
    consent?: boolean;
  },
) => {
  const enquiry = await Enquiry.create({
    id: randomUUID(),
    reference: enquiryReference(),
    businessId,
    name: input.name,
    email: input.email ?? null,
    phone: input.phone?.replace(/[\s()-]/g, '') ?? null,
    eventType: input.eventType ?? null,
    eventDate: input.eventDate ?? null,
    guestCount: input.guestCount ?? null,
    message: input.message,
    source: input.source ?? null,
    consentAt: input.consent ? new Date() : null,
  });
  return enquiry.toObject();
};

export const listEnquiries = async (
  businessId: string,
  input: {
    q?: string;
    status?: 'new' | 'contacted' | 'qualified' | 'converted' | 'closed';
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
) => {
  const filter: Record<string, unknown> = { businessId };
  if (input.status) filter.status = input.status;
  if (input.from || input.to) {
    filter.eventDate = {
      ...(input.from ? { $gte: input.from } : {}),
      ...(input.to ? { $lte: input.to } : {}),
    };
  }
  if (input.q) {
    const escaped = input.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query = new RegExp(escaped, 'i');
    filter.$or = [
      { reference: query },
      { name: query },
      { email: query },
      { phone: query },
      { eventType: query },
      { message: query },
    ];
  }
  const [data, total] = await Promise.all([
    Enquiry.find(filter)
      .sort({ createdAt: -1, id: 1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean(),
    Enquiry.countDocuments(filter),
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

export const getEnquiry = async (businessId: string, id: string) => {
  const enquiry = await Enquiry.findOne({ businessId, id }).lean();
  if (!enquiry) throw notFound();
  return enquiry;
};

export const updateEnquiry = async (
  businessId: string,
  id: string,
  actorId: string,
  requestId: string,
  input: {
    status?: 'new' | 'contacted' | 'qualified' | 'closed';
    assignedTo?: string | null;
    internalNotes?: string | null;
    version: number;
  },
) => {
  return runTransaction(async (session) => {
    const enquiry = await Enquiry.findOne({ businessId, id }).session(session);
    if (!enquiry) throw notFound();
    if (enquiry.version !== input.version) {
      throw new AppError(409, 'VERSION_CONFLICT', 'The enquiry changed; reload and retry.', undefined, {
        ETag: `W/"${enquiry.version}"`,
      });
    }
    if (enquiry.status === 'converted' && input.status) {
      throw new AppError(409, 'ENQUIRY_CONVERTED', 'A converted enquiry cannot change status.');
    }
    if (input.assignedTo) {
      const membership = await Membership.exists({
        businessId,
        id: input.assignedTo,
        status: 'active',
      }).session(session);
      if (!membership) {
        throw new AppError(422, 'INVALID_ASSIGNEE', 'Assignee must be an active staff member of this business.');
      }
    }

    const changes: Record<string, unknown> = {};
    if (input.status !== undefined) changes.status = input.status;
    if (input.assignedTo !== undefined) changes.assignedTo = input.assignedTo;
    if (input.internalNotes !== undefined) changes.internalNotes = input.internalNotes;
    const updated = await Enquiry.findOneAndUpdate(
      { businessId, id, version: input.version },
      { $set: changes, $inc: { version: 1 } },
      { new: true, runValidators: true, session },
    ).lean();
    if (!updated) {
      const current = await Enquiry.findOne({ businessId, id }).session(session).lean();
      if (!current) throw notFound();
      throw new AppError(409, 'VERSION_CONFLICT', 'The enquiry changed; reload and retry.', undefined, {
        ETag: `W/"${current.version}"`,
      });
    }
    await AuditEvent.create(
      [{
        businessId,
        actorId,
        resourceType: 'enquiry',
        resourceId: id,
        action: 'enquiry.updated',
        requestId,
        details: { changedFields: Object.keys(changes) },
      }],
      { session },
    );
    return updated;
  });
};

export const convertEnquiryToBooking = async (
  businessId: string,
  actorId: string,
  requestId: string,
  id: string,
  input: Omit<BookingInput, 'customer' | 'customerId'>,
) => {
  try {
    return await runTransaction(async (session) => {
      const enquiry = await Enquiry.findOne({ businessId, id }).session(session);
      if (!enquiry) throw notFound();
      if (enquiry.status === 'converted' && enquiry.bookingId) {
        const booking = await Booking.findOne({ businessId, id: enquiry.bookingId }).session(session).lean();
        if (!booking) throw new Error('Converted enquiry refers to a missing booking.');
        return booking;
      }
      if (enquiry.status === 'closed') {
        throw new AppError(409, 'ENQUIRY_CLOSED', 'A closed enquiry cannot be converted.');
      }
      if (!enquiry.email && !enquiry.phone) {
        throw new AppError(422, 'CONTACT_REQUIRED', 'Add an email address or phone number before converting this enquiry.');
      }

      const bookingInput: BookingInput = {
        ...input,
        customer: {
          name: enquiry.name,
          ...(enquiry.email ? { email: enquiry.email } : {}),
          ...(enquiry.phone ? { phone: enquiry.phone } : {}),
        },
        eventName: input.eventName || enquiry.eventType || 'Event',
        eventDate: input.eventDate || enquiry.eventDate || '',
        guestCount: input.guestCount ?? enquiry.guestCount ?? undefined,
      };
      const booking = await createAdminBookingInSession(
        businessId,
        actorId,
        bookingInput,
        `enquiry-convert:${id}`,
        session,
        requestId,
      );
      enquiry.status = 'converted';
      enquiry.bookingId = booking.id;
      enquiry.version += 1;
      await enquiry.save({ session });
      await AuditEvent.create(
        [{
          businessId,
          actorId,
          resourceType: 'enquiry',
          resourceId: id,
          action: 'enquiry.converted',
          requestId,
          details: { bookingId: booking.id, bookingReference: booking.reference },
        }],
        { session },
      );
      return booking;
    });
  } catch (error) {
    const current = await Enquiry.findOne({ businessId, id }).lean();
    if (current?.status === 'converted' && current.bookingId) {
      const booking = await Booking.findOne({ businessId, id: current.bookingId }).lean();
      if (booking) return booking;
    }
    throw error;
  }
};
