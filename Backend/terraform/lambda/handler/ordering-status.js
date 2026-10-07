"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");

const MAX_BODY_BYTES = 4 * 1024;
const MAX_MESSAGE_LENGTH = 300;
const ORDERING_CONFIG_ID = "CONFIG#ORDERING";
const ORDERING_CONFIG_ENTITY_TYPE = "ORDERING_CONFIG";
const DEFAULT_PAUSED_MESSAGE = "Online ordering is temporarily paused.";

let sharedDocumentClient;

const getDocumentClient = () => {
  if (!sharedDocumentClient) {
    sharedDocumentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({}),
    );
  }

  return sharedDocumentClient;
};

const requestMethod = (event) =>
  event?.httpMethod || event?.requestContext?.http?.method;

const getClaims = (event) =>
  event?.requestContext?.authorizer?.claims ||
  event?.requestContext?.authorizer?.jwt?.claims ||
  {};

const parseGroups = (claim) => {
  if (Array.isArray(claim)) {
    return claim
      .filter((group) => typeof group === "string")
      .map((group) => group.trim())
      .filter(Boolean);
  }

  if (typeof claim !== "string" || !claim.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(claim);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((group) => typeof group === "string")
        .map((group) => group.trim())
        .filter(Boolean);
    }
  } catch {
    // REST API Cognito authorizers commonly expose comma-separated groups.
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
    "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Cache-Control": "no-store",
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

const validateStatusPayload = (payload) => {
  if (!isPlainObject(payload)) {
    return {
      errors: [{ field: "body", message: "must be a JSON object" }],
    };
  }

  const errors = [];
  for (const field of Object.keys(payload)) {
    if (field !== "acceptingOrders" && field !== "message") {
      errors.push({ field, message: "is not an allowed field" });
    }
  }

  if (typeof payload.acceptingOrders !== "boolean") {
    errors.push({
      field: "acceptingOrders",
      message: "must be a boolean",
    });
  }

  let message = "";
  if (Object.hasOwn(payload, "message")) {
    if (typeof payload.message !== "string") {
      errors.push({ field: "message", message: "must be a string" });
    } else {
      message = payload.message.trim();
      if (message.length > MAX_MESSAGE_LENGTH) {
        errors.push({
          field: "message",
          message: `must not exceed ${MAX_MESSAGE_LENGTH} characters`,
        });
      }
    }
  }

  if (payload.acceptingOrders === false && !message) {
    errors.push({
      field: "message",
      message: "must not be empty when ordering is paused",
    });
  }

  return {
    errors,
    ...(errors.length === 0
      ? { value: { acceptingOrders: payload.acceptingOrders, message } }
      : {}),
  };
};

const toStatusResponse = (item) => {
  if (!item) {
    return { acceptingOrders: true, message: "" };
  }

  if (
    item.orderId !== ORDERING_CONFIG_ID ||
    item.entityType !== ORDERING_CONFIG_ENTITY_TYPE ||
    typeof item.acceptingOrders !== "boolean" ||
    typeof item.message !== "string"
  ) {
    const error = new Error("Invalid stored ordering configuration");
    error.name = "InvalidStoredOrderingConfigError";
    throw error;
  }

  const storedMessage = item.message.trim();
  if (storedMessage.length > MAX_MESSAGE_LENGTH) {
    const error = new Error("Invalid stored ordering configuration");
    error.name = "InvalidStoredOrderingConfigError";
    throw error;
  }

  return {
    acceptingOrders: item.acceptingOrders,
    message:
      !item.acceptingOrders && !storedMessage
        ? DEFAULT_PAUSED_MESSAGE
        : storedMessage,
    ...(typeof item.updatedAt === "string"
      ? { updatedAt: item.updatedAt }
      : {}),
  };
};

const createOrderingStatusHandler = (dependencies = {}) => {
  const documentClient = dependencies.documentClient || getDocumentClient();
  const ordersTableName =
    dependencies.ordersTableName ?? process.env.ORDERS_TABLE;
  const allowedOrigin =
    dependencies.allowedOrigin ?? process.env.CORS_ALLOWED_ORIGIN ?? "*";
  const configuredAdminGroup =
    dependencies.adminGroupName ?? process.env.ADMIN_GROUP_NAME ?? "admin";
  const adminGroupName =
    typeof configuredAdminGroup === "string" && configuredAdminGroup.trim()
      ? configuredAdminGroup.trim()
      : "admin";
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  return async (event) => {
    const method = requestMethod(event);
    if (method !== "GET" && method !== "PUT") {
      return errorResponse(
        405,
        "METHOD_NOT_ALLOWED",
        "Only GET and PUT are supported.",
        allowedOrigin,
      );
    }

    let claims;
    if (method === "PUT") {
      claims = getClaims(event);
      if (typeof claims.sub !== "string" || !claims.sub.trim()) {
        return errorResponse(
          401,
          "UNAUTHORIZED",
          "A valid Cognito token is required.",
          allowedOrigin,
        );
      }

      if (
        !parseGroups(claims["cognito:groups"]).includes(adminGroupName)
      ) {
        return errorResponse(
          403,
          "FORBIDDEN",
          `Membership in the ${adminGroupName} Cognito group is required.`,
          allowedOrigin,
        );
      }
    }

    if (!ordersTableName) {
      logger.error("ORDERS_TABLE is not configured");
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The ordering status is unavailable.",
        allowedOrigin,
      );
    }

    if (method === "PUT") {
      const parsedBody = parseRequestBody(event);
      if (parsedBody.error) {
        return errorResponse(
          parsedBody.error.statusCode || 400,
          parsedBody.error.code,
          parsedBody.error.message,
          allowedOrigin,
        );
      }

      const validation = validateStatusPayload(parsedBody.value);
      if (validation.errors.length > 0) {
        return errorResponse(
          422,
          "VALIDATION_ERROR",
          "The ordering status is invalid.",
          allowedOrigin,
          validation.errors,
        );
      }

      try {
        const currentTime = now();
        const date =
          currentTime instanceof Date
            ? currentTime
            : new Date(currentTime);
        const item = {
          orderId: ORDERING_CONFIG_ID,
          entityType: ORDERING_CONFIG_ENTITY_TYPE,
          acceptingOrders: validation.value.acceptingOrders,
          message: validation.value.message,
          updatedAt: date.toISOString(),
          updatedBy: claims.sub.trim(),
        };

        await documentClient.send(
          new PutCommand({
            TableName: ordersTableName,
            Item: item,
          }),
        );

        return jsonResponse(200, toStatusResponse(item), allowedOrigin);
      } catch (error) {
        logger.error("Could not update ordering status", {
          errorName: error?.name,
          requestId: error?.$metadata?.requestId,
        });
        return errorResponse(
          500,
          "INTERNAL_ERROR",
          "The ordering status could not be changed.",
          allowedOrigin,
        );
      }
    }

    try {
      const result = await documentClient.send(
        new GetCommand({
          TableName: ordersTableName,
          Key: { orderId: ORDERING_CONFIG_ID },
          ConsistentRead: true,
        }),
      );

      return jsonResponse(
        200,
        toStatusResponse(result.Item),
        allowedOrigin,
      );
    } catch (error) {
      logger.error("Could not load ordering status", {
        errorName: error?.name,
        requestId: error?.$metadata?.requestId,
      });
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The ordering status is unavailable.",
        allowedOrigin,
      );
    }
  };
};

exports.DEFAULT_PAUSED_MESSAGE = DEFAULT_PAUSED_MESSAGE;
exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
exports.MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH;
exports.ORDERING_CONFIG_ENTITY_TYPE = ORDERING_CONFIG_ENTITY_TYPE;
exports.ORDERING_CONFIG_ID = ORDERING_CONFIG_ID;
exports.createOrderingStatusHandler = createOrderingStatusHandler;
exports.validateStatusPayload = validateStatusPayload;
exports.fn = createOrderingStatusHandler();
