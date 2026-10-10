import { Router } from 'express';
import mongoose from 'mongoose';

const healthRouter = Router();

healthRouter.get('/health', (_request, response) => {
  const databaseConnected = mongoose.connection.readyState === 1;
  const status = databaseConnected ? 200 : 503;

  response.status(status).json({
    data: {
      status: databaseConnected ? 'ok' : 'unavailable',
      database: databaseConnected ? 'connected' : 'disconnected',
    },
  });
});

export default healthRouter;
