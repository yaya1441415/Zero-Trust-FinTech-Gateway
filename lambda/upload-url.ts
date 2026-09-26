import { randomUUID } from 'node:crypto';
import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});

// Only these file types are accepted
const ALLOWED_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || !sub) {
    return { statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) };
  }

  let body: { contentType?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ message: 'Body must be JSON' }) };
  }

  const ext = body.contentType ? ALLOWED_TYPES[body.contentType] : undefined;
  if (!ext) {
    return { statusCode: 400, body: JSON.stringify({ message: 'Unsupported content type' }) };
  }

  // The server picks the file name, never the client.
  // Each user's files go under their own sub.
  const key = `uploads/${sub}/${randomUUID()}.${ext}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: key,
      ContentType: body.contentType, // client must send this exact Content-Type
    }),
    { expiresIn: 300, signableHeaders: new Set(['content-type']) }, // 5 minutes
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadUrl, key, expiresInSeconds: 300 }),
  };
};