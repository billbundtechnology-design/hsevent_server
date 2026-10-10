import { Router } from 'express';
import { createPublicEnquiryController } from '../controllers/enquiry.controller.js';
import { createRateLimiter } from '../middleware/rate-limit.middleware.js';

const publicEnquiryRouter = Router();
publicEnquiryRouter.post(
  '/enquiries',
  createRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    code: 'RATE_LIMITED',
    detail: 'Too many enquiries. Please try again later.',
  }),
  createPublicEnquiryController,
);

export default publicEnquiryRouter;
