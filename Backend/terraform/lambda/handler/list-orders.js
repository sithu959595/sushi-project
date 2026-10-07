"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_TOKEN_LENGTH = 2048;
const ORDER_ENTITY_TYPE = "ORDER";
const ALLOWED_QUERY_FIELDS = new Set(["limit", "nextToken"]);
const PAGINATION_KEY_FIELDS = new Set([
  "orderId",
  "entityType",
  "createdAt",
]);

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
    // REST API Cognito authorizers commonly expose a comma-separated string.
  }

  return claim
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);
};

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const jsonResponse = (statusCode, payload, allowedOrigin) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
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

const decodePaginationToken = (token) => {
  if (
    typeof token !== "string" ||
    !token ||
    token.length > MAX_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(token)
  ) {
    return undefined;
  }

  try {
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      !isPlainObject(value) ||
      Object.keys(value).length !== PAGINATION_KEY_FIELDS.size ||
      !Object.keys(value).every((field) =>
        PAGINATION_KEY_FIELDS.has(field),
      ) ||
      typeof value.orderId !== "string" ||
      !value.orderId ||
      typeof value.createdAt !== "string" ||
      !value.createdAt ||
      value.entityType !== ORDER_ENTITY_TYPE
    ) {
      return undefined;
    }

    return value;
  } catch {
    return undefined;
  }
};

const encodePaginationToken = (key) =>
  Buffer.from(JSON.stringify(key), "utf8").toString("base64url");

const parseQuery = (event) => {
  const query = event?.queryStringParameters;
  if (query === null || query === undefined) {
    return { value: { limit: DEFAULT_LIMIT } };
  }

  if (!isPlainObject(query)) {
    return {
      errors: [
        { field: "query", message: "must contain valid query parameters" },
      ],
    };
  }

  const errors = [];
  Object.keys(query).forEach((field) => {
    if (!ALLOWED_QUERY_FIELDS.has(field)) {
      errors.push({ field, message: "is not an allowed query parameter" });
    }
  });

  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    if (
      typeof query.limit !== "string" ||
      !/^[1-9]\d*$/u.test(query.limit) ||
      Number(query.limit) > MAX_LIMIT
    ) {
      errors.push({
        field: "limit",
        message: `must be an integer between 1 and ${MAX_LIMIT}`,
      });
    } else {
      limit = Number(query.limit);
    }
  }

  let exclusiveStartKey;
  if (query.nextToken !== undefined) {
    exclusiveStartKey = decodePaginationToken(query.nextToken);
    if (!exclusiveStartKey) {
      errors.push({
        field: "nextToken",
        message: "must be a valid pagination token",
      });
    }
  }

  return { errors, value: { limit, exclusiveStartKey } };
};

const toAdminOrder = (order) => ({
  orderId: order.orderId,
  status: order.status,
  notificationStatus: order.notificationStatus,
  fulfillment: order.fulfillment,
  pickupContact: order.pickupContact,
  items: order.items,
  itemCount: order.itemCount,
  currency: order.currency,
  subtotalCents: order.subtotalCents,
  totalCents: order.totalCents,
  customerNote: order.customerNote,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
  ...(typeof order.pickupTime === "string" && order.pickupTime
    ? { pickupTime: order.pickupTime }
    : {}),
  ...(typeof order.scheduledPickupTime === "string" &&
  order.scheduledPickupTime
    ? { scheduledPickupTime: order.scheduledPickupTime }
    : {}),
  ...(typeof order.failedToPickupAt === "string" &&
  order.failedToPickupAt
    ? { failedToPickupAt: order.failedToPickupAt }
    : {}),
  ...(typeof order.restaurantNote === "string" &&
  order.restaurantNote
    ? { restaurantNote: order.restaurantNote }
    : {}),
  ...(typeof order.customerEmail === "string"
    ? { customerEmail: order.customerEmail }
    : {}),
});

const createListOrdersHandler = (dependencies = {}) => {
  const documentClient = dependencies.documentClient || getDocumentClient();
  const tableName = dependencies.tableName ?? process.env.ORDERS_TABLE;
  const indexName =
    dependencies.indexName ?? process.env.ORDERS_LIST_INDEX;
  const allowedOrigin =
    dependencies.allowedOrigin ?? process.env.CORS_ALLOWED_ORIGIN ?? "*";
  const adminGroupName =
    dependencies.adminGroupName ?? process.env.ADMIN_GROUP_NAME ?? "admin";
  const logger = dependencies.logger || console;

  return async (event = {}) => {
    const claims = getClaims(event);
    if (typeof claims.sub !== "string" || !claims.sub.trim()) {
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

    if (!tableName || !indexName) {
      logger.error("ORDERS_TABLE or ORDERS_LIST_INDEX is not configured");
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The orders could not be loaded.",
        allowedOrigin,
      );
    }

    const query = parseQuery(event);
    if (query.errors?.length > 0) {
      return errorResponse(
        400,
        "INVALID_QUERY",
        "The order-list query is invalid.",
        allowedOrigin,
        query.errors,
      );
    }

    try {
      const response = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: indexName,
          KeyConditionExpression: "#entityType = :orderType",
          ExpressionAttributeNames: {
            "#entityType": "entityType",
          },
          ExpressionAttributeValues: {
            ":orderType": ORDER_ENTITY_TYPE,
          },
          ScanIndexForward: false,
          Limit: query.value.limit,
          ...(query.value.exclusiveStartKey
            ? { ExclusiveStartKey: query.value.exclusiveStartKey }
            : {}),
        }),
      );

      const orders = (response.Items || [])
        .filter(
          (item) =>
            isPlainObject(item) &&
            item.entityType === ORDER_ENTITY_TYPE &&
            typeof item.orderId === "string" &&
            item.orderId,
        )
        .map(toAdminOrder);
      const nextToken = response.LastEvaluatedKey
        ? encodePaginationToken(response.LastEvaluatedKey)
        : null;

      return jsonResponse(200, { orders, nextToken }, allowedOrigin);
    } catch (error) {
      logger.error("Could not list orders", {
        errorName: error?.name,
        requestId: error?.$metadata?.requestId,
      });

      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The orders could not be loaded.",
        allowedOrigin,
      );
    }
  };
};

exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
exports.MAX_LIMIT = MAX_LIMIT;
exports.ORDER_ENTITY_TYPE = ORDER_ENTITY_TYPE;
exports.createListOrdersHandler = createListOrdersHandler;
exports.decodePaginationToken = decodePaginationToken;
exports.encodePaginationToken = encodePaginationToken;
exports.fn = createListOrdersHandler();
