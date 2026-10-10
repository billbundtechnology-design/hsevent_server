import mongoose from 'mongoose';
import app from './app.js';
import { env } from './config/env.js';

const server = async (): Promise<void> => {
  await mongoose.connect(env.MONGODB_URI);

  const listener = app.listen(env.PORT, () => {
    console.info(`Rentos API listening on port ${env.PORT}`);
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    console.info(`${signal} received; shutting down`);
    listener.close((error) => {
      if (error) {
        console.error('Failed to close the HTTP server:', error);
        process.exitCode = 1;
      }

      void mongoose.disconnect().catch((disconnectError: unknown) => {
        console.error('Failed to disconnect from MongoDB:', disconnectError);
        process.exitCode = 1;
      });
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};

server().catch((error: unknown) => {
  console.error('Failed to start the Rentos API:', error);
  process.exitCode = 1;
});
