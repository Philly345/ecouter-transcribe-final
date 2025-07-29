import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export async function uploadFile(file, fileName, contentType) {
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: file,
      ContentType: contentType,
    });

    const result = await s3Client.send(command);
    
    return {
      success: true,
      url: `${process.env.R2_PUBLIC_URL}/${fileName}`,
      key: fileName,
    };
  } catch (error) {
    console.error('Error uploading to R2:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

export async function deleteFile(fileName) {
  try {
    const command = new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
    });

    await s3Client.send(command);
    return { success: true };
  } catch (error) {
    console.error('Error deleting from R2:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

export async function getFileUrl(fileName) {
  return `${process.env.R2_PUBLIC_URL}/${fileName}`;
}
