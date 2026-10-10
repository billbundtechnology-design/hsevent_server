import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateBookingAmounts,
  calculateCancellationImpact,
  startedRentalPeriods,
} from '../src/services/booking-pricing.js';
import { adminCreateBookingSchema, cancelBookingSchema, publicCreateBookingSchema } from '../src/validation/booking.schemas.js';

test('rental charge counts each started 24-hour period', () => {
  const start = new Date('2027-01-01T00:00:00.000Z');
  assert.equal(startedRentalPeriods(start, new Date(start.getTime() + 1)), 1);
  assert.equal(startedRentalPeriods(start, new Date(start.getTime() + 24 * 60 * 60 * 1000)), 1);
  assert.equal(startedRentalPeriods(start, new Date(start.getTime() + 24 * 60 * 60 * 1000 + 1)), 2);
  assert.equal(startedRentalPeriods(start, new Date(start.getTime() + 48 * 60 * 60 * 1000)), 2);
  assert.throws(() => startedRentalPeriods(start, start), RangeError);
});

test('discount is applied before tax and deposit is calculated on the total', () => {
  assert.deepEqual(calculateBookingAmounts(2000, 10, 10, 50), {
    discountKobo: 200,
    taxKobo: 180,
    totalKobo: 1980,
    requiredDepositKobo: 990,
  });
  assert.deepEqual(calculateBookingAmounts(1, 0, 0, 50), {
    discountKobo: 0,
    taxKobo: 0,
    totalKobo: 1,
    requiredDepositKobo: 1,
  });
  const maxSafeKobo = Number.MAX_SAFE_INTEGER;
  const expectedDiscount = Number((BigInt(maxSafeKobo) * 3333n + 5000n) / 10000n);
  assert.equal(calculateBookingAmounts(maxSafeKobo, 33.33, 0, 0).discountKobo, expectedDiscount);
});

test('cancellation impact selects policy by cutoff and does not issue refunds', () => {
  const booking = {
    eventDate: '2027-01-10',
    startAt: new Date('2027-01-10T12:00:00.000Z'),
    paidKobo: 10001,
  };
  const policy = {
    cancellationCutoffHours: 24,
    refundPercentBeforeCutoff: 75,
    refundPercentAfterCutoff: 20,
  };
  assert.equal(calculateCancellationImpact(
    booking,
    policy,
    new Date('2027-01-01T00:00:00.000Z'),
  ).eligibleRefundKobo, 7501);
  const afterCutoff = calculateCancellationImpact(
    booking,
    policy,
    new Date('2027-01-09T13:00:00.000Z'),
  );
  assert.equal(afterCutoff.eligibleRefundKobo, 2000);
  assert.equal(afterCutoff.automaticRefund, false);
});

test('public booking cannot set a discount and cancellation requires explicit confirmation', () => {
  const publicInput = {
    name: 'Test booking',
    eventName: 'Test event',
    businessArm: 'planning',
    eventDate: '2027-01-10',
    customer: { name: 'Test customer', email: 'test@example.com' },
    items: [{ listingId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', quantity: 1 }],
    discountPercent: 100,
  };
  const parsedPublic = publicCreateBookingSchema.parse(publicInput);
  assert.equal('discountPercent' in parsedPublic, false);
  assert.equal(adminCreateBookingSchema.safeParse(publicInput).success, true);
  assert.equal(cancelBookingSchema.safeParse({ reason: 'Changed plans', version: 1 }).success, false);
  assert.equal(cancelBookingSchema.safeParse({ reason: 'Changed plans', version: 1, confirm: true }).success, true);
});
