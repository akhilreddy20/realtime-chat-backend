import dotenv from 'dotenv';

dotenv.config();

const list = (value, fallback) =>
  (value || fallback).split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5001,
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS) || 7 * 24 * 60 * 60,
  // Same-origin by default (the bundled web client is served by this server).
  corsOrigins: list(process.env.CORS_ORIGINS, 'http://localhost:5173'),
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
  limits: {
    messageText: 2000,
    imageBytes: 2 * 1024 * 1024,
    pageSize: 30,
  },
};

export const isProduction = () => config.env === 'production';

export const assertConfig = () => {
  const missing = ['mongoUri', 'jwtSecret'].filter((k) => !config[k]);
  if (missing.length) throw new Error(`Missing required config: ${missing.join(', ')}`);
};
