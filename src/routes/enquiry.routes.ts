import { Router } from 'express';
import {
  convertEnquiryController,
  getEnquiryController,
  listEnquiriesController,
  updateEnquiryController,
} from '../controllers/enquiry.controller.js';
import { authenticate, requirePermission } from '../middleware/auth.middleware.js';

const enquiryRouter = Router();
enquiryRouter.use(authenticate);
enquiryRouter.get('/', requirePermission('bookings.read'), listEnquiriesController);
enquiryRouter.get('/:id', requirePermission('bookings.read'), getEnquiryController);
enquiryRouter.patch('/:id', requirePermission('bookings.write'), updateEnquiryController);
enquiryRouter.post('/:id/convert-to-booking', requirePermission('bookings.write'), convertEnquiryController);

export default enquiryRouter;
