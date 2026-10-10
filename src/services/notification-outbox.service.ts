import { NotificationOutbox } from '../models/notification-outbox.model.js';
import { AppError } from '../middleware/http-error.js';

const MAX_ATTEMPTS = 8;
const LEASE_MS = 60_000;

export interface BookingNotificationMessage {
  id: string;
  businessId: string;
  type: 'booking.created' | 'booking.updated' | 'booking.confirmed' | 'booking.cancelled' | 'booking.completed';
  recipient: { name: string; email: string | null; phone: string | null };
  payload: Record<string, unknown>;
  attempts: number;
}

export type NotificationDeliveryAdapter = (
  message: BookingNotificationMessage,
) => Promise<void>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, 1000) : 'Unknown notification delivery error.';

export const processNextBookingNotification = async (
  deliver: NotificationDeliveryAdapter,
  now = new Date(),
) => {
  const notification = await NotificationOutbox.findOneAndUpdate(
    {
      $or: [
        { status: 'queued', nextAttemptAt: { $lte: now } },
        { status: 'processing', leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: { status: 'processing', leaseUntil: new Date(now.getTime() + LEASE_MS) },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } },
  ).lean();
  if (!notification) return { status: 'empty' as const };
  if (!notification.recipient) {
    await NotificationOutbox.updateOne(
      { id: notification.id, status: 'processing' },
      {
        $set: {
          status: 'failed',
          leaseUntil: null,
          lastError: 'Notification recipient is missing.',
        },
      },
    );
    throw new AppError(500, 'INVALID_NOTIFICATION', 'Queued booking notification has no recipient.');
  }

  const message: BookingNotificationMessage = {
    id: notification.id,
    businessId: notification.businessId,
    type: notification.type,
    recipient: {
      name: notification.recipient.name,
      email: notification.recipient.email ?? null,
      phone: notification.recipient.phone ?? null,
    },
    payload: notification.payload as Record<string, unknown>,
    attempts: notification.attempts,
  };

  try {
    await deliver(message);
    const result = await NotificationOutbox.updateOne(
      { id: notification.id, status: 'processing' },
      { $set: { status: 'sent', sentAt: new Date(), leaseUntil: null, lastError: null } },
    );
    if (result.modifiedCount !== 1) {
      throw new AppError(409, 'NOTIFICATION_LEASE_LOST', 'Notification was claimed by another worker before delivery could be recorded.');
    }
    return { status: 'sent' as const, id: notification.id };
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOTIFICATION_LEASE_LOST') throw error;
    const terminal = notification.attempts >= MAX_ATTEMPTS;
    const backoffMs = Math.min(60 * 60 * 1000, 1000 * 2 ** Math.min(notification.attempts, 12));
    const update = await NotificationOutbox.updateOne(
      { id: notification.id, status: 'processing' },
      {
        $set: {
          status: terminal ? 'failed' : 'queued',
          nextAttemptAt: new Date(now.getTime() + backoffMs),
          leaseUntil: null,
          lastError: errorMessage(error),
        },
      },
    );
    if (update.modifiedCount !== 1) {
      throw new AppError(409, 'NOTIFICATION_LEASE_LOST', 'Notification delivery failed and its lease was lost.');
    }
    return {
      status: terminal ? 'failed' as const : 'retrying' as const,
      id: notification.id,
      error: errorMessage(error),
    };
  }
};
