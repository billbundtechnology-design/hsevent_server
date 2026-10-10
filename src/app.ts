import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import errorHandler from './middleware/error-handler.js';
import healthRouter from './routes/health.routes.js';
import authRouter from './routes/auth.routes.js';
import customerRouter from './routes/customer.routes.js';
import staffRouter from './routes/staff.routes.js';
import bookingRouter, { publicBookingRouter } from './routes/booking.routes.js';
import inventoryRouter from './routes/inventory.routes.js';
import { listingRouter, publicCatalogueRouter, serviceRouter, venueRouter } from './routes/catalogue.routes.js';
import paymentRouter from './routes/payment.routes.js';
import dispatchRouter from './routes/dispatch.routes.js';
import settingsRouter from './routes/settings.routes.js';
import reportRouter from './routes/report.routes.js';
import enquiryRouter from './routes/enquiry.routes.js';
import publicEnquiryRouter from './routes/public-enquiry.routes.js';

const app = express();

app.disable('x-powered-by');
app.use(
  pinoHttp({
    genReqId: () => randomUUID(),
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers.x-api-key',
      'req.headers.x-booking-access-token',
    ],
    customProps: (request) => ({ requestId: request.id }),
  }),
);
app.use((request, response, next) => {
  response.setHeader('X-Request-Id', String(request.id));
  next();
});
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, !origin || env.CORS_ORIGINS.includes(origin));
    },
  }),
);
app.use(express.json({ limit: '1mb' }));

app.use('/api/v1', healthRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/customers', customerRouter);
app.use('/api/v1/staff', staffRouter);
app.use('/api/v1/public', publicBookingRouter);
app.use('/api/v1/public', publicCatalogueRouter);
app.use('/api/v1/public', publicEnquiryRouter);
app.use('/api/v1/bookings', bookingRouter);
app.use('/api/v1/inventory', inventoryRouter);
app.use('/api/v1/venues', venueRouter);
app.use('/api/v1/services', serviceRouter);
app.use('/api/v1/listings', listingRouter);
app.use('/api/v1/payments', paymentRouter);
app.use('/api/v1/dispatches', dispatchRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/reports', reportRouter);
app.use('/api/v1/enquiries', enquiryRouter);

app.use((request, response) => {
  response
    .status(404)
    .type('application/problem+json')
    .json({
      type: 'https://api.rentos.example/problems/not-found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'The requested resource was not found.',
      requestId: String(request.id),
    });
});

app.use(errorHandler);

export default app;
