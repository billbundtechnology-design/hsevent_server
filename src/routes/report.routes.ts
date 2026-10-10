import { Router } from 'express';
import {
  bookingExportController,
  bookingsReportController,
  inventoryReportController,
  paymentExportController,
  paymentsReportController,
  summaryReportController,
} from '../controllers/report.controller.js';
import { authenticate, requirePermission } from '../middleware/auth.middleware.js';

const reportRouter = Router();
reportRouter.use(authenticate);
reportRouter.get('/summary', requirePermission('reports.read'), summaryReportController);
reportRouter.get('/bookings', requirePermission('reports.read'), bookingsReportController);
reportRouter.get('/inventory', requirePermission('reports.read'), inventoryReportController);
reportRouter.get('/payments', requirePermission('reports.read'), paymentsReportController);
reportRouter.get('/exports/bookings', requirePermission('reports.export'), bookingExportController);
reportRouter.get('/exports/payments', requirePermission('reports.export'), paymentExportController);

export default reportRouter;
