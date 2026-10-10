import { AppError } from '../middleware/http-error.js';
import { Booking } from '../models/booking.model.js';
import { InventoryAllocation } from '../models/inventory-allocation.model.js';
import { Listing } from '../models/listing.model.js';
import { Payment } from '../models/payment.model.js';
import { Refund } from '../models/refund.model.js';

const MAX_EXPORT_ROWS = 10000;

interface DateRange {
  from?: string;
  to?: string;
}

const eventDateFilter = (range: DateRange): Record<string, unknown> => ({
  ...(range.from || range.to
    ? {
        eventDate: {
          ...(range.from ? { $gte: range.from } : {}),
          ...(range.to ? { $lte: range.to } : {}),
        },
      }
    : {}),
});

const transactionDateFilter = (range: DateRange, field: 'recordedAt' | 'refundedAt') => ({
  ...(range.from || range.to
    ? {
        [field]: {
          ...(range.from ? { $gte: new Date(`${range.from}T00:00:00.000Z`) } : {}),
          ...(range.to
            ? {
                $lt: new Date(
                  new Date(`${range.to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000,
                ),
              }
            : {}),
        },
      }
    : {}),
});

const dateBucket = (value: string, groupBy: 'day' | 'week' | 'month'): string => {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (groupBy === 'month') return value.slice(0, 7);
  if (groupBy === 'week') {
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - day + 1);
    return date.toISOString().slice(0, 10);
  }
  return value;
};

const escapeCsvCell = (value: unknown): string => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

export const toCsv = (headers: string[], rows: Array<Array<unknown>>): string =>
  [headers, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');

export const getSummaryReport = async (businessId: string, range: DateRange) => {
  const bookings = await Booking.aggregate<{
    count: number;
    bookingValueKobo: number;
    outstandingKobo: number;
    averageBookingValueKobo: number;
  }>([
    { $match: { businessId, status: { $ne: 'cancelled' }, ...eventDateFilter(range) } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        bookingValueKobo: { $sum: '$totalKobo' },
        outstandingKobo: { $sum: '$balanceKobo' },
        averageBookingValueKobo: { $avg: '$totalKobo' },
      },
    },
  ]);
  const paymentMatch = { businessId, status: 'succeeded', ...transactionDateFilter(range, 'recordedAt') };
  const refundMatch = { businessId, status: 'succeeded', ...transactionDateFilter(range, 'refundedAt') };
  const [payments, refunds] = await Promise.all([
    Payment.aggregate<{ total: number; count: number }>([
      { $match: paymentMatch },
      { $group: { _id: null, total: { $sum: '$amountKobo' }, count: { $sum: 1 } } },
    ]),
    Refund.aggregate<{ total: number; count: number }>([
      { $match: refundMatch },
      { $group: { _id: null, total: { $sum: '$amountKobo' }, count: { $sum: 1 } } },
    ]),
  ]);
  const booking = bookings[0];
  const collectedKobo = payments[0]?.total ?? 0;
  const refundedKobo = refunds[0]?.total ?? 0;
  return {
    bookings: {
      count: booking?.count ?? 0,
      valueKobo: booking?.bookingValueKobo ?? 0,
      outstandingKobo: booking?.outstandingKobo ?? 0,
      averageValueKobo: Math.round(booking?.averageBookingValueKobo ?? 0),
    },
    payments: {
      successfulCount: payments[0]?.count ?? 0,
      collectedKobo,
      refundedCount: refunds[0]?.count ?? 0,
      refundedKobo,
      netCollectedKobo: collectedKobo - refundedKobo,
    },
    meta: {
      bookingDateBasis: 'eventDate',
      transactionDateBasis: 'recordedAt/refundedAt',
      from: range.from ?? null,
      to: range.to ?? null,
      currency: 'NGN',
    },
  };
};

export const getBookingReport = async (
  businessId: string,
  range: DateRange & { groupBy: 'day' | 'week' | 'month' },
) => {
  const bookings = await Booking.aggregate<{
    _id: { eventDate: string; status: string; businessArm: string };
    count: number;
    totalValueKobo: number;
  }>([
    { $match: { businessId, ...eventDateFilter(range) } },
    {
      $group: {
        _id: { eventDate: '$eventDate', status: '$status', businessArm: '$businessArm' },
        count: { $sum: 1 },
        totalValueKobo: { $sum: '$totalKobo' },
      },
    },
  ]);
  const groups = new Map<string, {
    period: string;
    status: string;
    businessArm: string;
    count: number;
    totalValueKobo: number;
  }>();
  for (const booking of bookings) {
    const period = dateBucket(booking._id.eventDate, range.groupBy);
    const key = `${period}:${booking._id.status}:${booking._id.businessArm}`;
    const current = groups.get(key) ?? {
      period,
      status: booking._id.status,
      businessArm: booking._id.businessArm,
      count: 0,
      totalValueKobo: 0,
    };
    current.count += booking.count;
    current.totalValueKobo += booking.totalValueKobo;
    groups.set(key, current);
  }
  return {
    data: [...groups.values()].sort((left, right) =>
      left.period.localeCompare(right.period) ||
      left.status.localeCompare(right.status) ||
      left.businessArm.localeCompare(right.businessArm),
    ),
    meta: { dateBasis: 'eventDate', groupBy: range.groupBy, from: range.from ?? null, to: range.to ?? null },
  };
};

export const getInventoryReport = async (businessId: string) => {
  const items = await Listing.find({ businessId, kind: 'rental' })
    .select('id category active totalUnits damagedUnits missingUnits')
    .lean();
  const allocatedRows = await InventoryAllocation.aggregate<{ _id: string; units: number }>([
    {
      $match: {
        businessId,
        status: 'active',
        startAt: { $lte: new Date() },
        endAt: { $gt: new Date() },
      },
    },
    { $group: { _id: '$listingId', units: { $sum: '$quantity' } } },
  ]);
  const allocatedByListing = new Map(allocatedRows.map(({ _id, units }) => [_id, units]));
  const groups = new Map<string, {
    category: string;
    itemCount: number;
    activeItemCount: number;
    totalUnits: number;
    availableUnits: number;
    allocatedUnits: number;
    damagedUnits: number;
    missingUnits: number;
  }>();
  for (const item of items) {
    const current = groups.get(item.category) ?? {
      category: item.category,
      itemCount: 0,
      activeItemCount: 0,
      totalUnits: 0,
      availableUnits: 0,
      allocatedUnits: 0,
      damagedUnits: 0,
      missingUnits: 0,
    };
    const totalUnits = item.totalUnits ?? 0;
    const damagedUnits = item.damagedUnits ?? 0;
    const missingUnits = item.missingUnits ?? 0;
    const allocatedUnits = allocatedByListing.get(item.id) ?? 0;
    current.itemCount += 1;
    current.activeItemCount += item.active ? 1 : 0;
    current.totalUnits += totalUnits;
    current.allocatedUnits += allocatedUnits;
    current.availableUnits += Math.max(0, totalUnits - damagedUnits - missingUnits - allocatedUnits);
    current.damagedUnits += damagedUnits;
    current.missingUnits += missingUnits;
    groups.set(item.category, current);
  }
  const data = [...groups.values()].map((group) => ({
    ...group,
    utilizationPercent: group.totalUnits === 0
      ? 0
      : Math.round((group.allocatedUnits / group.totalUnits) * 10000) / 100,
  })).sort((left, right) => left.category.localeCompare(right.category));
  return {
    data,
    meta: { dateBasis: 'currentSnapshot', generatedAt: new Date().toISOString() },
  };
};

export const getPaymentReport = async (
  businessId: string,
  range: DateRange & { groupBy: 'day' | 'week' | 'month' },
) => {
  const groupedTransactions = (field: 'recordedAt' | 'refundedAt') => ({
    $group: {
      _id: {
        period: { $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: 'UTC' } },
        method: '$method',
      },
      count: { $sum: 1 },
      amountKobo: { $sum: '$amountKobo' },
    },
  });
  const [payments, refunds] = await Promise.all([
    Payment.aggregate<{
      _id: { period: string; method: string };
      count: number;
      amountKobo: number;
    }>([
      { $match: { businessId, status: 'succeeded', ...transactionDateFilter(range, 'recordedAt') } },
      groupedTransactions('recordedAt'),
    ]),
    Refund.aggregate<{
      _id: { period: string; method: string };
      count: number;
      amountKobo: number;
    }>([
      { $match: { businessId, status: 'succeeded', ...transactionDateFilter(range, 'refundedAt') } },
      groupedTransactions('refundedAt'),
    ]),
  ]);
  const groups = new Map<string, {
    period: string;
    method: string;
    paymentCount: number;
    collectedKobo: number;
    refundCount: number;
    refundedKobo: number;
  }>();
  for (const payment of payments) {
    const period = dateBucket(payment._id.period, range.groupBy);
    const key = `${period}:${payment._id.method}`;
    const current = groups.get(key) ?? {
      period,
      method: payment._id.method,
      paymentCount: 0,
      collectedKobo: 0,
      refundCount: 0,
      refundedKobo: 0,
    };
    current.paymentCount += payment.count;
    current.collectedKobo += payment.amountKobo;
    groups.set(key, current);
  }
  for (const refund of refunds) {
    const period = dateBucket(refund._id.period, range.groupBy);
    const key = `${period}:${refund._id.method}`;
    const current = groups.get(key) ?? {
      period,
      method: refund._id.method,
      paymentCount: 0,
      collectedKobo: 0,
      refundCount: 0,
      refundedKobo: 0,
    };
    current.refundCount += refund.count;
    current.refundedKobo += refund.amountKobo;
    groups.set(key, current);
  }
  return {
    data: [...groups.values()].map((group) => ({
      ...group,
      netCollectedKobo: group.collectedKobo - group.refundedKobo,
    })).sort((left, right) => left.period.localeCompare(right.period) || left.method.localeCompare(right.method)),
    meta: { transactionDateBasis: 'recordedAt/refundedAt', groupBy: range.groupBy, from: range.from ?? null, to: range.to ?? null },
  };
};

export const exportBookings = async (
  businessId: string,
  range: DateRange & { status?: string; businessArm?: string },
) => {
  const records = await Booking.find({
    businessId,
    ...eventDateFilter(range),
    ...(range.status ? { status: range.status } : {}),
    ...(range.businessArm ? { businessArm: range.businessArm } : {}),
  }).sort({ eventDate: 1, reference: 1 }).limit(MAX_EXPORT_ROWS + 1).lean();
  if (records.length > MAX_EXPORT_ROWS) {
    throw new AppError(422, 'EXPORT_TOO_LARGE', 'Narrow the date range or add filters; exports are limited to 10,000 rows.');
  }
  return {
    headers: [
      'reference',
      'eventDate',
      'eventName',
      'businessArm',
      'status',
      'subtotalKobo',
      'discountPercent',
      'discountKobo',
      'taxPercent',
      'taxKobo',
      'requiredDepositKobo',
      'totalKobo',
      'paidKobo',
      'balanceKobo',
      'paymentStatus',
    ],
    rows: records.map((booking) => [
      booking.reference,
      booking.eventDate,
      booking.eventName,
      booking.businessArm,
      booking.status,
      booking.subtotalKobo,
      booking.discountPercent,
      booking.discountKobo,
      booking.taxPercent,
      booking.taxKobo,
      booking.requiredDepositKobo,
      booking.totalKobo,
      booking.paidKobo,
      booking.balanceKobo,
      booking.paymentStatus,
    ]),
  };
};

export const exportPayments = async (
  businessId: string,
  range: DateRange & { method?: 'bank_transfer' | 'pos' | 'cash' },
) => {
  const [payments, refunds] = await Promise.all([
    Payment.find({
      businessId,
      status: 'succeeded',
      ...transactionDateFilter(range, 'recordedAt'),
      ...(range.method ? { method: range.method } : {}),
    }).sort({ recordedAt: 1, reference: 1 }).limit(MAX_EXPORT_ROWS + 1).lean(),
    Refund.find({
      businessId,
      status: 'succeeded',
      ...transactionDateFilter(range, 'refundedAt'),
      ...(range.method ? { method: range.method } : {}),
    }).sort({ refundedAt: 1, reference: 1 }).limit(MAX_EXPORT_ROWS + 1).lean(),
  ]);
  if (payments.length + refunds.length > MAX_EXPORT_ROWS) {
    throw new AppError(422, 'EXPORT_TOO_LARGE', 'Narrow the date range or add filters; exports are limited to 10,000 rows.');
  }
  return {
    headers: ['recordType', 'reference', 'bookingId', 'date', 'method', 'status', 'amountKobo', 'externalReference'],
    rows: [
      ...payments.map((payment) => [
        'payment', payment.reference, payment.bookingId, payment.recordedAt.toISOString(),
        payment.method, 'succeeded', payment.amountKobo, payment.externalReference,
      ]),
      ...refunds.map((refund) => [
        'refund', refund.reference, refund.bookingId, refund.refundedAt.toISOString(),
        refund.method, 'succeeded', refund.amountKobo, refund.externalReference,
      ]),
    ].sort((left, right) => String(left[3]).localeCompare(String(right[3]))),
  };
};
