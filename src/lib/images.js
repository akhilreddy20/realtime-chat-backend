import { v2 as cloudinary } from 'cloudinary';
import { config } from '../config/index.js';
import { badRequest, HttpError } from './errors.js';

const DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/;

export const imagesEnabled = () =>
  Boolean(config.cloudinary.cloudName && config.cloudinary.apiKey && config.cloudinary.apiSecret);

if (imagesEnabled()) {
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
  });
}

/** Validates a base64 data URL and returns its decoded size in bytes. */
export const validateImageDataUrl = (dataUrl, maxBytes = config.limits.imageBytes) => {
  if (typeof dataUrl !== 'string' || !DATA_URL_RE.test(dataUrl)) {
    throw badRequest('image must be a base64 data URL (png, jpeg, gif or webp)');
  }
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (bytes > maxBytes) throw badRequest(`image must be at most ${Math.round(maxBytes / 1024)} KB`);
  return bytes;
};

/** Uploads an image to Cloudinary and returns its HTTPS URL. */
export const uploadImage = async (dataUrl, folder) => {
  if (!imagesEnabled()) throw new HttpError(501, 'Image uploads are not configured on this server');
  validateImageDataUrl(dataUrl);
  const result = await cloudinary.uploader.upload(dataUrl, { folder, resource_type: 'image' });
  return result.secure_url;
};
