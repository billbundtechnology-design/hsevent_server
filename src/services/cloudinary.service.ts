import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { AppError } from '../middleware/http-error.js';

if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export interface UploadedInventoryImage {
  url: string;
  publicId: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
}

export const uploadInventoryImage = async (
  businessId: string,
  file: Express.Multer.File,
): Promise<UploadedInventoryImage> => {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw new AppError(503, 'IMAGE_UPLOAD_NOT_CONFIGURED', 'Image upload is not configured.');
  }

  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        folder: `rentos/${businessId}/inventory`,
        resource_type: 'image',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        overwrite: false,
        unique_filename: true,
        transformation: [{ width: 2400, height: 2400, crop: 'limit' }],
      },
      (error, result) => {
        if (error || !result) {
          reject(new AppError(502, 'IMAGE_UPLOAD_FAILED', 'Cloudinary could not upload this image.'));
          return;
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: result.bytes,
        });
      },
    );
    upload.end(file.buffer);
  });
};

export const isInventoryImageOwnedByBusiness = (
  businessId: string,
  publicId: string,
): boolean => publicId.startsWith(`rentos/${businessId}/inventory/`);
