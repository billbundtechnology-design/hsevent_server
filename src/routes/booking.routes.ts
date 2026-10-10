import { Router } from 'express';
import {
  cancelBookingController,
  bookingCancellationPreviewController,
  completeBookingController,
  confirmBookingController,
  createBookingController,
  createPublicBookingController,
  getBookingController,
  getPublicBookingRequestController,
  listBookingsController,
  updateBookingController,
} from '../controllers/booking.controller.js';
import { recordPaymentController } from '../controllers/payment.controller.js';
import { createDispatchController } from '../controllers/dispatch.controller.js';
import { authenticate, requirePermission } from '../middleware/auth.middleware.js';
import { createRateLimiter } from '../middleware/rate-limit.middleware.js';

export const publicBookingRouter = Router();
publicBookingRouter.post(
  '/booking-requests',
  createRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    code: 'RATE_LIMITED',
    detail: 'Too many booking requests. Please try again later.',
  }),
  createPublicBookingController,
);
publicBookingRouter.get('/booking-requests/:id', getPublicBookingRequestController);

const bookingRouter = Router();
bookingRouter.use(authenticate);
bookingRouter.get('/', requirePermission('bookings.read'), listBookingsController);
bookingRouter.post('/', requirePermission('bookings.write'), createBookingController);
bookingRouter.get('/:id', requirePermission('bookings.read'), getBookingController);
bookingRouter.patch('/:id', requirePermission('bookings.write'), updateBookingController);
bookingRouter.post('/:id/confirm', requirePermission('bookings.approve'), confirmBookingController);
bookingRouter.post('/:id/cancellation-preview', requirePermission('bookings.cancel'), bookingCancellationPreviewController);
bookingRouter.post('/:id/cancel', requirePermission('bookings.cancel'), cancelBookingController);
bookingRouter.post('/:id/complete', requirePermission('bookings.complete'), completeBookingController);
bookingRouter.post('/:id/payments', requirePermission('payments.record'), recordPaymentController);
bookingRouter.post('/:id/dispatches', requirePermission('dispatch.write'), createDispatchController);

export default bookingRouter;
