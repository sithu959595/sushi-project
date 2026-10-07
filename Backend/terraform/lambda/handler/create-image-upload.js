"use strict";

const { randomUUID } = require("node:crypto");

const MAX_BODY_BYTES = 4 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UPLOAD_URL_TTL_SECONDS = 300;
const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CONTENT_TYPE_EXTENSIONS = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});
const ALLOWED_FIELDS = new Set(["dishId", "contentType", "size"]);

let sharedAwsDependencies;
let sharedS3Client;

// Cache the production S3 dependencies and client across warm invocations.
const loadAwsDependencies = () => {
  if (!sharedAwsDependencies) {
    const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
    const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
    sharedAwsDependencies = { S3Client, PutObjectCommand, getSignedUrl };
  }

  return sharedAwsDependencies;
};

const getDefaultS3Client = (S3Client) => {
  if (!sharedS3Client) {
    sharedS3Client = new S3Client({});
  }

  return sharedS3Client;
};

const getClaims = (event) =>
  event?.requestContext?.authorizer?.claims ||
  event?.requestContext?.authorizer?.jwt?.claims ||
  {};

const parseGroups = (claim) => {
  if (Array.isArray(claim)) {
    return claim.map(String);
  }

  if (typeof claim !== "string" || !claim.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(claim);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // API Gateway commonly supplies Cognito groups as a comma-separated string.
  }

  return claim
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);
};

const jsonResponse = (statusCode, payload, allowedOrigin) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

const errorResponse = (statusCode, code, message, allowedOrigin, details) =>
  jsonResponse(
    statusCode,
    {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    },
    allowedOrigin,
  );

const parseRequestBody = (event) => {
  if (typeof event?.body !== "string") {
    return {
      error: {
        code: "INVALID_JSON",
        message: "The request body must be a JSON object.",
      },
    };
  }

  let body = event.body;
  if (event.isBase64Encoded) {
    body = Buffer.from(body, "base64").toString("utf8");
  }

  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return {
      error: {
        statusCode: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "The request body must not exceed 4 KiB.",
      },
    };
  }

  try {
    return { value: JSON.parse(body) };
  } catch {
    return {
      error: {
        code: "INVALID_JSON",
        message: "The request body contains invalid JSON.",
      },
    };
  }
};

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const validateUploadRequest = (payload) => {
  if (!isPlainObject(payload)) {
    return {
      errors: [{ field: "body", message: "must be a JSON object" }],
    };
  }

  const errors = [];
  for (const field of Object.keys(payload)) {
    if (!ALLOWED_FIELDS.has(field)) {
      errors.push({ field, message: "is not an allowed field" });
    }
  }

  let dishId;
  if (typeof payload.dishId !== "string") {
    errors.push({ field: "dishId", message: "must be a string" });
  } else {
    dishId = payload.dishId.trim();
    if (!dishId) {
      errors.push({ field: "dishId", message: "must not be empty" });
    } else if (dishId.length > 100) {
      errors.push({
        field: "dishId",
        message: "must not exceed 100 characters",
      });
    } else if (!/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(dishId)) {
      errors.push({
        field: "dishId",
        message: "must contain only letters, numbers, hyphens, or underscores",
      });
    }
  }

  const extension = CONTENT_TYPE_EXTENSIONS[payload.contentType];
  if (typeof payload.contentType !== "string") {
    errors.push({ field: "contentType", message: "must be a string" });
  } else if (!extension) {
    errors.push({
      field: "contentType",
      message: "must be one of: image/jpeg, image/png, image/webp",
    });
  }

  if (!Number.isInteger(payload.size)) {
    errors.push({ field: "size", message: "must be an integer" });
  } else if (payload.size <= 0) {
    errors.push({ field: "size", message: "must be greater than zero" });
  } else if (payload.size > MAX_IMAGE_BYTES) {
    errors.push({
      field: "size",
      message: "must not exceed 5 MiB",
    });
  }

  return {
    errors,
    value: {
      dishId,
      contentType: payload.contentType,
      size: payload.size,
      extension,
    },
  };
};

const createImageUploadHandler = (dependencies = {}) => {
  const bucketName =
    dependencies.bucketName ?? process.env.DISH_IMAGES_BUCKET;
  const allowedOrigin =
    dependencies.allowedOrigin ?? process.env.CORS_ALLOWED_ORIGIN ?? "*";
  const adminGroupName =
    dependencies.adminGroupName ?? process.env.ADMIN_GROUP_NAME ?? "admin";
  const createUuid = dependencies.randomUUID || randomUUID;
  const logger = dependencies.logger || console;

  return async (event) => {
    const claims = getClaims(event);

    if (!claims.sub) {
      return errorResponse(
        401,
        "UNAUTHORIZED",
        "A valid Cognito token is required.",
        allowedOrigin,
      );
    }

    if (
      adminGroupName &&
      !parseGroups(claims["cognito:groups"]).includes(adminGroupName)
    ) {
      return errorResponse(
        403,
        "FORBIDDEN",
        `Membership in the ${adminGroupName} Cognito group is required.`,
        allowedOrigin,
      );
    }

    if (!bucketName) {
      logger.error("DISH_IMAGES_BUCKET is not configured");
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The image upload could not be prepared.",
        allowedOrigin,
      );
    }

    const parsedBody = parseRequestBody(event);
    if (parsedBody.error) {
      return errorResponse(
        parsedBody.error.statusCode || 400,
        parsedBody.error.code,
        parsedBody.error.message,
        allowedOrigin,
      );
    }

    const validation = validateUploadRequest(parsedBody.value);
    if (validation.errors.length > 0) {
      return errorResponse(
        422,
        "VALIDATION_ERROR",
        "The image upload data is invalid.",
        allowedOrigin,
        validation.errors,
      );
    }

    try {
      const key = `dishes/${validation.value.dishId}/${createUuid()}.${validation.value.extension}`;
      const defaults =
        dependencies.s3Client &&
        dependencies.PutObjectCommand &&
        dependencies.getSignedUrl
          ? undefined
          : loadAwsDependencies();
      const S3Client = defaults?.S3Client;
      const s3Client =
        dependencies.s3Client || getDefaultS3Client(S3Client);
      const PutObjectCommand =
        dependencies.PutObjectCommand || defaults.PutObjectCommand;
      const getSignedUrl = dependencies.getSignedUrl || defaults.getSignedUrl;

      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        ContentType: validation.value.contentType,
        CacheControl: IMAGE_CACHE_CONTROL,
      });
      const uploadUrl = await getSignedUrl(s3Client, command, {
        expiresIn: UPLOAD_URL_TTL_SECONDS,
        signableHeaders: new Set(["cache-control", "content-type"]),
      });

      if (typeof uploadUrl !== "string" || !uploadUrl) {
        throw new Error("The S3 presigner returned an invalid URL");
      }

      return jsonResponse(
        200,
        {
          uploadUrl,
          key,
          expiresIn: UPLOAD_URL_TTL_SECONDS,
          uploadHeaders: {
            "Cache-Control": IMAGE_CACHE_CONTROL,
            "Content-Type": validation.value.contentType,
          },
        },
        allowedOrigin,
      );
    } catch (error) {
      logger.error("Could not create image upload URL", {
        errorName: error?.name,
        requestId: error?.$metadata?.requestId,
      });

      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The image upload could not be prepared.",
        allowedOrigin,
      );
    }
  };
};

exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
exports.MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
exports.IMAGE_CACHE_CONTROL = IMAGE_CACHE_CONTROL;
exports.UPLOAD_URL_TTL_SECONDS = UPLOAD_URL_TTL_SECONDS;
exports.createImageUploadHandler = createImageUploadHandler;

// Initialize the comparatively large S3 SDK during Lambda's init phase. Keeping
// this work out of the request handler prevents cold starts from consuming the
// function's invocation timeout before the URL can be signed.
const defaultAwsDependencies = loadAwsDependencies();
exports.fn = createImageUploadHandler({
  s3Client: getDefaultS3Client(defaultAwsDependencies.S3Client),
  PutObjectCommand: defaultAwsDependencies.PutObjectCommand,
  getSignedUrl: defaultAwsDependencies.getSignedUrl,
});
