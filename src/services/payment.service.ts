import { createHash, randomUUID } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { AppError } from '../middleware/http-error.js';
import { AuditEvent } from '../models/audit-event.model.js';
import { Booking } from '../models/booking.model.js';
import { Payment } from '../models/payment.model.js';
import { Refund } from '../models/refund.model.js';

interface PaymentListInput {
  bookingId?: string;
  status?: 'succeeded' | 'partially_refunded' | 'refunded';
  method?: 'bank_transfer' | 'pos' | 'cash';
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

interface PaymentInput {
  amountKobo: number;
  method: 'bank_transfer' | 'pos' | 'cash';
  externalReference?: string;
  recordedAt?: string;
  notes?: string;
}

interface RefundInput {
  amountKobo: number;
  method: 'bank_transfer' | 'pos' | 'cash';
  externalReference?: string;
  reason: string;
  refundedAt?: string;
}

const notFound = (): AppError => new AppError(404, 'NOT_FOUND', 'The requested payment record was not found.');
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const reference = (prefix: 'PAY' | 'REF'): string =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;

const idempotencyHash = (key: string): string => hash(key);
const payloadHash = (input: object): string => hash(JSON.stringify(input));

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
  if (result === undefined) throw new Error('Payment transaction completed without a result.');
  return result;
};

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

const updateBookingBalance = async (
  bookingId: string,
  businessId: string,
  session: ClientSession,
): Promise<{ paidKobo: number; balanceKobo: number; paymentStatus: 'unpaid' | 'part_paid' | 'paid' }> => {
  const booking = await Booking.findOne({ id: bookingId, businessId }).session(session);
  if (!booking) throw notFound();
  const [payments, refunds] = await Promise.all([
    Payment.aggregate<{ total: number }>([
      { $match: { businessId, bookingId, status: 'succeeded' } },
      { $group: { _id: null, total: { $sum: '$amountKobo' } } },
    ]).session(session),
    Refund.aggregate<{ total: number }>([
      { $match: { businessId, bookingId, status: 'succeeded' } },
      { $group: { _id: null, total: { $sum: '$amountKobo' } } },
    ]).session(session),
  ]);
  const paidKobo = Math.max(0, (payments[0]?.total ?? 0) - (refunds[0]?.total ?? 0));
  const balanceKobo = Math.max(0, booking.totalKobo - paidKobo);
  const paymentStatus = paidKobo === 0 ? 'unpaid' : paidKobo >= booking.totalKobo ? 'paid' : 'part_paid';
  booking.paidKobo = paidKobo;
  booking.balanceKobo = balanceKobo;
  booking.paymentStatus = paymentStatus;
  booking.version += 1;
  await booking.save({ session });
  return { paidKobo, balanceKobo, paymentStatus };
};

const getPaymentView = async (payment: {
  id: string;
  reference: string;
  businessId: string;
  bookingId: string;
  amountKobo: number;
  method: string;
  status: string;
  externalReference?: string | null;
  recordedAt: Date;
  notes?: string | null;
  createdBy: string;
  createdAt?: Date;
}, session?: ClientSession) => {
  let query = Refund.aggregate<{ total: number }>([
    { $match: { businessId: payment.businessId, paymentId: payment.id, status: 'succeeded' } },
    { $group: { _id: null, total: { $sum: '$amountKobo' } } },
  ]);
  if (session) query = query.session(session);
  const refunds = await query;
  const refundedAmountKobo = refunds[0]?.total ?? 0;
  return {
    id: payment.id,
    reference: payment.reference,
    businessId: payment.businessId,
    bookingId: payment.bookingId,
    amountKobo: payment.amountKobo,
    method: payment.method,
    externalReference: payment.externalReference ?? null,
    recordedAt: payment.recordedAt,
    notes: payment.notes ?? null,
    createdBy: payment.createdBy,
    createdAt: payment.createdAt,
    refundedAmountKobo,
    refundableAmountKobo: Math.max(0, payment.amountKobo - refundedAmountKobo),
    status: refundedAmountKobo === 0
      ? 'succeeded'
      : refundedAmountKobo >= payment.amountKobo
        ? 'refunded'
        : 'partially_refunded',
  };
};

const checkIdempotentPayment = async (
  businessId: string,
  keyHash: string,
  inputHash: string,
) => {
  const existing = await Payment.findOne({ businessId, idempotencyKeyHash: keyHash })
    .select('+idempotencyKeyHash +idempotencyPayloadHash')
    .lean();
  if (!existing) return null;
  if (existing.idempotencyPayloadHash !== inputHash) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with different payment details.');
  }
  const { idempotencyKeyHash: _keyHash, idempotencyPayloadHash: _payloadHash, ...payment } = existing;
  return getPaymentView(payment);
};

const checkIdempotentRefund = async (
  businessId: string,
  keyHash: string,
  inputHash: string,
) => {
  const existing = await Refund.findOne({ businessId, idempotencyKeyHash: keyHash })
    .select('+idempotencyKeyHash +idempotencyPayloadHash')
    .lean();
  if (!existing) return null;
  if (existing.idempotencyPayloadHash !== inputHash) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with different refund details.');
  }
  const { idempotencyKeyHash: _keyHash, idempotencyPayloadHash: _payloadHash, ...refund } = existing;
  return refund;
};

export const recordPayment = async (
  businessId: string,
  bookingId: string,
  actorId: string,
  requestId: string,
  idempotencyKey: string,
  input: PaymentInput,
) => {
  const keyHash = idempotencyHash(idempotencyKey);
  const inputHash = payloadHash({ bookingId, ...input });
  const replay = await checkIdempotentPayment(businessId, keyHash, inputHash);
  if (replay) return { payment: replay, replayed: true };

  try {
    const payment = await runTransaction(async (session) => {
      const booking = await Booking.findOne({ businessId, id: bookingId }).session(session);
      if (!booking) throw notFound();
      if (booking.status === 'cancelled') {
        throw new AppError(409, 'BOOKING_CANCELLED', 'Payments cannot be recorded against a cancelled booking.');
      }
      const [paymentTotals, refundTotals] = await Promise.all([
        Payment.aggregate<{ total: number }>([
          { $match: { businessId, bookingId, status: 'succeeded' } },
          { $group: { _id: null, total: { $sum: '$amountKobo' } } },
        ]).session(session),
        Refund.aggregate<{ total: number }>([
          { $match: { businessId, bookingId, status: 'succeeded' } },
          { $group: { _id: null, total: { $sum: '$amountKobo' } } },
        ]).session(session),
      ]);
      const netPaid = (paymentTotals[0]?.total ?? 0) - (refundTotals[0]?.total ?? 0);
      const remainingBalance = Math.max(0, booking.totalKobo - netPaid);
      if (input.amountKobo > remainingBalance) {
        throw new AppError(422, 'PAYMENT_EXCEEDS_BALANCE', 'Payment amount exceeds the remaining booking balance.', undefined, {
          'X-Remaining-Balance-Kobo': String(remainingBalance),
        });
      }
      const [created] = await Payment.create(
        [{
          id: randomUUID(),
          reference: reference('PAY'),
          businessId,
          bookingId,
          amountKobo: input.amountKobo,
          method: input.method,
          status: 'succeeded',
          externalReference: input.externalReference ?? null,
          recordedAt: input.recordedAt ? new Date(input.recordedAt) : new Date(),
          notes: input.notes ?? null,
          createdBy: actorId,
          idempotencyKeyHash: keyHash,
          idempotencyPayloadHash: inputHash,
        }],
        { session },
      );
      if (!created) throw new Error('Payment creation failed.');
      await updateBookingBalance(bookingId, businessId, session);
      await AuditEvent.create(
        [{
          businessId,
          actorId,
          requestId,
          resourceType: 'payment',
          resourceId: created.id,
          action: 'payment.recorded',
          details: { bookingId, amountKobo: created.amountKobo, method: created.method },
        }],
        { session },
      );
      return created.toObject();
    });
    return { payment: await getPaymentView(payment), replayed: false };
  } catch (error) {
    if (isDuplicateKey(error)) {
      const replayAfterRace = await checkIdempotentPayment(businessId, keyHash, inputHash);
      if (replayAfterRace) return { payment: replayAfterRace, replayed: true };
      throw new AppError(409, 'PAYMENT_REFERENCE_EXISTS', 'A payment with this external reference already exists.');
    }
    throw error;
  }
};

export const recordRefund = async (
  businessId: string,
  paymentId: string,
  actorId: string,
  requestId: string,
  idempotencyKey: string,
  input: RefundInput,
) => {
  const keyHash = idempotencyHash(idempotencyKey);
  const inputHash = payloadHash({ paymentId, ...input });
  const replay = await checkIdempotentRefund(businessId, keyHash, inputHash);
  if (replay) return { refund: replay, replayed: true };

  try {
    const refund = await runTransaction(async (session) => {
      const payment = await Payment.findOne({ businessId, id: paymentId, status: 'succeeded' }).session(session);
      if (!payment) throw notFound();
      const booking = await Booking.findOne({ businessId, id: payment.bookingId }).session(session);
      if (!booking) throw notFound();
      const existingRefunds = await Refund.aggregate<{ total: number }>([
        { $match: { businessId, paymentId, status: 'succeeded' } },
        { $group: { _id: null, total: { $sum: '$amountKobo' } } },
      ]).session(session);
      const refundableAmount = Math.max(0, payment.amountKobo - (existingRefunds[0]?.total ?? 0));
      if (input.amountKobo > refundableAmount) {
        throw new AppError(422, 'REFUND_EXCEEDS_CAPTURED_AMOUNT', 'Refund amount exceeds the payment’s remaining refundable amount.', undefined, {
          'X-Refundable-Amount-Kobo': String(refundableAmount),
        });
      }
      const [created] = await Refund.create(
        [{
          id: randomUUID(),
          reference: reference('REF'),
          businessId,
          paymentId,
          bookingId: payment.bookingId,
          amountKobo: input.amountKobo,
          method: input.method,
          status: 'succeeded',
          externalReference: input.externalReference ?? null,
          reason: input.reason,
          refundedAt: input.refundedAt ? new Date(input.refundedAt) : new Date(),
          createdBy: actorId,
          idempotencyKeyHash: keyHash,
          idempotencyPayloadHash: inputHash,
        }],
        { session },
      );
      if (!created) throw new Error('Refund creation failed.');
      await updateBookingBalance(payment.bookingId, businessId, session);
      await AuditEvent.create(
        [{
          businessId,
          actorId,
          requestId,
          resourceType: 'refund',
          resourceId: created.id,
          action: 'payment.refunded',
          details: {
            paymentId,
            bookingId: payment.bookingId,
            amountKobo: created.amountKobo,
            method: created.method,
            reason: created.reason,
          },
        }],
        { session },
      );
      return created.toObject();
    });
    return { refund, replayed: false };
  } catch (error) {
    if (isDuplicateKey(error)) {
      const replayAfterRace = await checkIdempotentRefund(businessId, keyHash, inputHash);
      if (replayAfterRace) return { refund: replayAfterRace, replayed: true };
      throw new AppError(409, 'REFUND_REFERENCE_EXISTS', 'A refund with this external reference already exists.');
    }
    throw error;
  }
};

export const listPayments = async (businessId: string, input: PaymentListInput) => {
  const filter: Record<string, unknown> = { businessId };
  if (input.bookingId) filter.bookingId = input.bookingId;
  if (input.method) filter.method = input.method;
  if (input.from || input.to) {
    filter.recordedAt = {
      ...(input.from ? { $gte: new Date(input.from) } : {}),
      ...(input.to ? { $lte: new Date(input.to) } : {}),
    };
  }
  const matchStatus = input.status;
  const result = await Payment.aggregate<{
    data: Array<Record<string, unknown>>;
    total: Array<{ count: number }>;
  }>([
    { $match: filter },
    {
      $lookup: {
        from: Refund.collection.name,
        let: { paymentId: '$id' },
        pipeline: [
          {
            $match: {
              businessId,
              status: 'succeeded',
              $expr: { $eq: ['$paymentId', '$$paymentId'] },
            },
          },
          { $group: { _id: null, amount: { $sum: '$amountKobo' } } },
        ],
        as: 'refundTotals',
      },
    },
    {
      $addFields: {
        refundedAmountKobo: { $ifNull: [{ $arrayElemAt: ['$refundTotals.amount', 0] }, 0] },
      },
    },
    {
      $addFields: {
        status: {
          $switch: {
            branches: [
              { case: { $eq: ['$refundedAmountKobo', 0] }, then: 'succeeded' },
              { case: { $gte: ['$refundedAmountKobo', '$amountKobo'] }, then: 'refunded' },
            ],
            default: 'partially_refunded',
          },
        },
      },
    },
    ...(matchStatus ? [{ $match: { status: matchStatus } }] : []),
    { $sort: { recordedAt: -1, id: 1 } },
    {
      $facet: {
        data: [
          { $skip: (input.page - 1) * input.pageSize },
          { $limit: input.pageSize },
          {
            $project: {
              id: 1,
              reference: 1,
              businessId: 1,
              bookingId: 1,
              amountKobo: 1,
              method: 1,
              status: 1,
              externalReference: 1,
              recordedAt: 1,
              notes: 1,
              createdBy: 1,
              createdAt: 1,
              refundedAmountKobo: 1,
              refundableAmountKobo: {
                $max: [0, { $subtract: ['$amountKobo', '$refundedAmountKobo'] }],
              },
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);
  const data = result[0]?.data ?? [];
  const statusTotal = result[0]?.total[0]?.count ?? 0;
  return {
    data,
    meta: {
      page: input.page,
      pageSize: input.pageSize,
      total: statusTotal,
      totalPages: Math.ceil(statusTotal / input.pageSize),
    },
  };
};

export const getPayment = async (businessId: string, paymentId: string) => {
  const payment = await Payment.findOne({ businessId, id: paymentId }).lean();
  if (!payment) throw notFound();
  const [view, refunds, booking] = await Promise.all([
    getPaymentView(payment),
    Refund.find({ businessId, paymentId }).sort({ refundedAt: -1 }).lean(),
    Booking.findOne({ businessId, id: payment.bookingId }).select('reference').lean(),
  ]);
  return { ...view, bookingReference: booking?.reference ?? null, refunds };
};
