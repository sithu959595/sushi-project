"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");
const { validateMenuPayload } = require("./validate-menu");

const MAX_BODY_BYTES = 64 * 1024;
const MENU_RECORD_ID = "MENU#CURRENT";

let sharedDocumentClient;

const getDocumentClient = () => {
  if (!sharedDocumentClient) {
    sharedDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  return sharedDocumentClient;
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
        message: "The request body must not exceed 64 KiB.",
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

const createReplaceDishesHandler = (dependencies = {}) => {
  const documentClient = dependencies.documentClient || getDocumentClient();
  const tableName = dependencies.tableName ?? process.env.DISHES_TABLE;
  const allowedOrigin =
    dependencies.allowedOrigin ?? process.env.CORS_ALLOWED_ORIGIN ?? "*";
  const adminGroupName =
    dependencies.adminGroupName ?? process.env.ADMIN_GROUP_NAME ?? "admin";
  const now = dependencies.now || (() => new Date());
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

    if (!tableName) {
      logger.error("DISHES_TABLE is not configured");
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The menu could not be saved.",
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

    const validation = validateMenuPayload(parsedBody.value);
    if (validation.errors.length > 0) {
      return errorResponse(
        422,
        "VALIDATION_ERROR",
        "The menu data is invalid.",
        allowedOrigin,
        validation.errors,
      );
    }

    const currentTime = now();
    const date = currentTime instanceof Date ? currentTime : new Date(currentTime);
    const version = date.getTime();
    const updatedAt = date.toISOString();
    const items = validation.value.items;

    try {
      await documentClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            id: MENU_RECORD_ID,
            items,
            version,
            updatedAt,
            updatedBy: String(claims.sub),
          },
        }),
      );

      return jsonResponse(200, { items, version, updatedAt }, allowedOrigin);
    } catch (error) {
      logger.error("Could not replace menu", {
        errorName: error?.name,
        requestId: error?.$metadata?.requestId,
      });

      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The menu could not be saved.",
        allowedOrigin,
      );
    }
  };
};

exports.MENU_RECORD_ID = MENU_RECORD_ID;
exports.createReplaceDishesHandler = createReplaceDishesHandler;
exports.fn = createReplaceDishesHandler();
