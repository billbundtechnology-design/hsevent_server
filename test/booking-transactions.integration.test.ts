import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

const testUri = process.env.MONGODB_TEST_URI;
process.env.JWT_SECRET ??= 'integration-test-jwt-secret-not-for-production';

test('MongoDB booking transactions enforce idempotency, deposits, availability, cancellation, and outbox', {
  skip: !testUri && 'Set MONGODB_TEST_URI to an isolated replica-set database (rentos_test_...).',
}, async () => {
  if (!testUri) return;
  const databaseName = new URL(testUri).pathname.replace(/^\//, '');
  if (!databaseName.startsWith('rentos_test_')) {
    throw new Error('MONGODB_TEST_URI must target an isolated database named rentos_test_... .');
  }

  const mongoose = (await import('mongoose')).default;
  await mongoose.connect(testUri);
  try {
    const [
      { Business },
      { Listing },
      { Booking },
      { InventoryAllocation },
      { NotificationOutbox },
      { Customer },
      { Payment },
      { Refund },
      { AuditEvent },
    ] =
      await Promise.all([
        import('../src/models/business.model.js'),
        import('../src/models/listing.model.js'),
        import('../src/models/booking.model.js'),
        import('../src/models/inventory-allocation.model.js'),
        import('../src/models/notification-outbox.model.js'),
        import('../src/models/customer.model.js'),
        import('../src/models/payment.model.js'),
        import('../src/models/refund.model.js'),
        import('../src/models/audit-event.model.js'),
      ]);
    await Promise.all([
      Business.init(),
      Listing.init(),
      Booking.init(),
      InventoryAllocation.init(),
      NotificationOutbox.init(),
      Customer.init(),
      Payment.init(),
      Refund.init(),
      AuditEvent.init(),
    ]);
    const { AppError } = await import('../src/middleware/http-error.js');
    const { createAdminBooking, confirmBooking, getBookingCancellationPreview, cancelBooking } =
      await import('../src/services/booking.service.js');
    const { recordPayment } = await import('../src/services/payment.service.js');
    const { processNextBookingNotification } =
      await import('../src/services/notification-outbox.service.js');

    const businessId = randomUUID();
    const listingId = randomUUID();
    const actorId = randomUUID();
    const futureStart = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    futureStart.setUTCHours(12, 0, 0, 0);
    const startAt = futureStart.toISOString();
    const endAt = new Date(futureStart.getTime() + 25 * 60 * 60 * 1000).toISOString();
    const eventDate = futureStart.toISOString().slice(0, 10);
    const context = {
      userId: actorId,
      membershipId: randomUUID(),
      businessId,
      role: 'owner' as const,
      permissions: [] as const,
    };

    try {
      await Business.create({
        id: businessId,
        name: 'Integration Test Business',
        bookingPolicies: {
          depositPercent: 50,
          taxPercent: 10,
          cancellationCutoffHours: 24,
          refundPercentBeforeCutoff: 50,
          refundPercentAfterCutoff: 0,
        },
        notifications: { bookingRequests: true },
      });
      await Listing.create({
        id: listingId,
        businessId,
        name: 'Test chairs',
        kind: 'rental',
        category: 'seating',
        priceKobo: 1000,
        unit: 'each',
        totalUnits: 1,
        active: true,
      });

      const makeInput = (email: string, discountPercent = 0) => ({
        customer: { name: 'Test Customer', email },
        eventName: 'Integration event',
        businessArm: 'rentals' as const,
        eventDate,
        startAt,
        endAt,
        items: [{ listingId, quantity: 1 }],
        discountPercent,
      });
      const firstInput = makeInput(`${randomUUID()}@example.test`, 10);
      const first = await createAdminBooking(context, firstInput, 'integration-key-first-001');
      assert.equal(first.booking.subtotalKobo, 2000);
      assert.equal(first.booking.discountKobo, 200);
      assert.equal(first.booking.taxKobo, 180);
      assert.equal(first.booking.totalKobo, 1980);
      assert.equal(first.booking.requiredDepositKobo, 990);

      const replay = await createAdminBooking(context, firstInput, 'integration-key-first-001');
      assert.equal(replay.replayed, true);
      assert.equal(replay.booking.id, first.booking.id);
      await assert.rejects(
        createAdminBooking(
          context,
          { ...firstInput, notes: 'Different payload' },
          'integration-key-first-001',
        ),
        (error: unknown) => error instanceof AppError && error.code === 'IDEMPOTENCY_KEY_REUSED',
      );

      const second = await createAdminBooking(
        context,
        makeInput(`${randomUUID()}@example.test`),
        'integration-key-second-002',
      );
      await assert.rejects(
        confirmBooking(businessId, first.booking.id, actorId),
        (error: unknown) => error instanceof AppError && error.code === 'DEPOSIT_REQUIRED',
      );

      for (const booking of [first.booking, second.booking]) {
        await recordPayment(
          businessId,
          booking.id,
          actorId,
          randomUUID(),
          `payment-key-${booking.id}`,
          { amountKobo: booking.requiredDepositKobo, method: 'bank_transfer' },
        );
      }
      const confirmations = await Promise.allSettled([
        confirmBooking(businessId, first.booking.id, actorId),
        confirmBooking(businessId, second.booking.id, actorId),
      ]);
      assert.equal(confirmations.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(confirmations.filter((result) => result.status === 'rejected').length, 1);
      const rejectedConfirmation = confirmations.find((result) => result.status === 'rejected');
      assert.ok(
        rejectedConfirmation?.status === 'rejected' &&
          rejectedConfirmation.reason instanceof AppError &&
          rejectedConfirmation.reason.code === 'AVAILABILITY_CONFLICT',
      );
      assert.equal(await InventoryAllocation.countDocuments({ businessId, listingId, status: 'active' }), 1);

      const third = await createAdminBooking(
        context,
        makeInput(`${randomUUID()}@example.test`),
        'integration-key-third-003',
      );
      await recordPayment(
        businessId,
        third.booking.id,
        actorId,
        randomUUID(),
        `payment-key-${third.booking.id}`,
        { amountKobo: third.booking.requiredDepositKobo, method: 'bank_transfer' },
      );
      const cancellationPreview = await getBookingCancellationPreview(businessId, third.booking.id);
      assert.equal(cancellationPreview.eligibleRefundKobo, Math.round(third.booking.requiredDepositKobo * 0.5));
      const cancellationResult = await cancelBooking(
        businessId,
        third.booking.id,
        'Customer changed plans',
        cancellationPreview.version,
        actorId,
        randomUUID(),
      );
      assert.equal(cancellationResult.booking.status, 'cancelled');
      assert.equal(cancellationResult.cancellation.automaticRefund, false);
      assert.equal(await Refund.countDocuments({ businessId, bookingId: third.booking.id }), 0);

      const queued = await NotificationOutbox.countDocuments({ businessId, status: 'queued' });
      assert.ok(queued >= 4);
      const failedDelivery = await processNextBookingNotification(async () => {
        throw new Error('Provider unavailable for integration test.');
      });
      assert.equal(failedDelivery.status, 'retrying');
      if (failedDelivery.status === 'retrying') {
        const retried = await NotificationOutbox.findOne({ id: failedDelivery.id }).lean();
        assert.equal(retried?.status, 'queued');
        assert.equal(retried?.attempts, 1);
        assert.equal(retried?.lastError, 'Provider unavailable for integration test.');
      }
      let deliveredId = '';
      const delivery = await processNextBookingNotification(async (message) => {
        deliveredId = message.id;
      });
      assert.equal(delivery.status, 'sent');
      assert.ok(deliveredId);
      assert.equal(
        (await NotificationOutbox.findOne({ id: deliveredId }).lean())?.status,
        'sent',
      );
    } finally {
      await Promise.all([
        Booking.deleteMany({ businessId }),
        InventoryAllocation.deleteMany({ businessId }),
        NotificationOutbox.deleteMany({ businessId }),
        Customer.deleteMany({ businessId }),
        Payment.deleteMany({ businessId }),
        Refund.deleteMany({ businessId }),
        AuditEvent.deleteMany({ businessId }),
        Listing.deleteMany({ businessId }),
        Business.deleteOne({ id: businessId }),
      ]);
    }
  } finally {
    await mongoose.disconnect();
  }
});
