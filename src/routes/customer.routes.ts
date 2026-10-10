import { Router } from 'express';
import {
  archiveCustomerController,
  customerBookingsController,
  createCustomerController,
  getCustomerController,
  listCustomersController,
  updateCustomerController,
} from '../controllers/customer.controller.js';
import { authenticate, requirePermission } from '../middleware/auth.middleware.js';

const customerRouter = Router();
customerRouter.use(authenticate);
customerRouter.get('/', requirePermission('customers.read'), listCustomersController);
customerRouter.post('/', requirePermission('customers.write'), createCustomerController);
customerRouter.get('/:id', requirePermission('customers.read'), getCustomerController);
customerRouter.patch('/:id', requirePermission('customers.write'), updateCustomerController);
customerRouter.post('/:id/archive', requirePermission('customers.write'), archiveCustomerController);
customerRouter.get('/:id/bookings', requirePermission('bookings.read'), customerBookingsController);

export default customerRouter;
