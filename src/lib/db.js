import mongoose from 'mongoose';
import { logger } from './logger.js';

export const connectDB = async (uri) => {
  await mongoose.connect(uri);
  logger.info('mongodb connected');
};

export const disconnectDB = () => mongoose.disconnect();
