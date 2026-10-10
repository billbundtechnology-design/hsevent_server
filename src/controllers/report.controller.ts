import type { RequestHandler } from 'express';
import { AppError } from '../middleware/http-error.js';
import {
  exportBookings,
  exportPayments,
  getBookingReport,
  getInventoryReport,
  getPaymentReport,
  getSummaryReport,
  toCsv,
} from '../services/report.service.js';
import {
  bookingExportSchema,
  bookingReportSchema,
  inventoryReportSchema,
  paymentExportSchema,
  paymentReportSchema,
  reportSummarySchema,
} from '../validation/report.schemas.js';
import { parseOrThrow } from '../validation/parse.js';

const businessId = (request: Parameters<RequestHandler>[0]) => {
  if (!request.authContext) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return request.authContext.businessId;
};

const sendCsv = (
  response: Parameters<RequestHandler>[1],
  filename: string,
  report: { headers: string[]; rows: Array<Array<unknown>> },
) => {
  response
    .status(200)
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    .setHeader('Cache-Control', 'no-store')
    .send(`\uFEFF${toCsv(report.headers, report.rows)}`);
};

export const summaryReportController: RequestHandler = async (request, response) => {
  const query = parseOrThrow(reportSummarySchema, request.query);
  response.json({ data: await getSummaryReport(businessId(request), query) });
};

export const bookingsReportController: RequestHandler = async (request, response) => {
  const query = parseOrThrow(bookingReportSchema, request.query);
  const report = await getBookingReport(businessId(request), {
    ...query,
    groupBy: query.groupBy ?? 'day',
  });
  response.json({ data: report });
};

export const inventoryReportController: RequestHandler = async (request, response) => {
  parseOrThrow(inventoryReportSchema, request.query);
  response.json({ data: await getInventoryReport(businessId(request)) });
};

export const paymentsReportController: RequestHandler = async (request, response) => {
  const query = parseOrThrow(paymentReportSchema, request.query);
  const report = await getPaymentReport(businessId(request), {
    ...query,
    groupBy: query.groupBy ?? 'day',
  });
  response.json({ data: report });
};

export const bookingExportController: RequestHandler = async (request, response) => {
  const query = parseOrThrow(bookingExportSchema, request.query);
  const report = await exportBookings(businessId(request), query);
  sendCsv(response, 'rentos-bookings.csv', report);
};

export const paymentExportController: RequestHandler = async (request, response) => {
  const query = parseOrThrow(paymentExportSchema, request.query);
  const report = await exportPayments(businessId(request), query);
  sendCsv(response, 'rentos-payments.csv', report);
};
