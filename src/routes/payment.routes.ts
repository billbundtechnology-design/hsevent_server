import { Router } from 'express';
import {
  createRefundController,
  getPaymentController,
  listPaymentsController,
} from '../controllers/payment.controller.js';
import { authenticate, requirePermission } from '../middleware/auth.middleware.js';

const paymentRouter = Router();
paymentRouter.use(authenticate);
paymentRouter.get('/', requirePermission('payments.read'), listPaymentsController);
paymentRouter.get('/:paymentId', requirePermission('payments.read'), getPaymentController);
paymentRouter.post(
  '/:paymentId/refunds',
  requirePermission('payments.refund'),
  createRefundController,
);

export default paymentRouter;
