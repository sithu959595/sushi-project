"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { customerOrderKeyFor } = require("./order-keys");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_TOKEN_LENGTH = 2048;
const ORDER_ENTITY_TYPE = "ORDER";
const ALLOWED_QUERY_FIELDS = new Set(["limit", "nextToken"]);
const PAGINATION_KEY_FIELDS = new Set([
  "orderId",
  "customerOrderKey",
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

const isPaginationKey = (value, expectedCustomerOrderKey) =>
  isPlainObject(value) &&
  Object.keys(value).length === PAGINATION_KEY_FIELDS.size &&
  Object.keys(value).every((field) => PAGINATION_KEY_FIELDS.has(field)) &&
  typeof value.orderId === "string" &&
  Boolean(value.orderId) &&
  typeof value.createdAt === "string" &&
  Boolean(value.createdAt) &&
  value.customerOrderKey === expectedCustomerOrderKey;

const decodePaginationToken = (token, expectedCustomerOrderKey) => {
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
    return isPaginationKey(value, expectedCustomerOrderKey)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

const encodePaginationToken = (key) =>
  Buffer.from(JSON.stringify(key), "utf8").toString("base64url");

const parseQuery = (event, customerOrderKey) => {
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
    exclusiveStartKey = decodePaginationToken(
      query.nextToken,
      customerOrderKey,
    );
    if (!exclusiveStartKey) {
      errors.push({
        field: "nextToken",
        message: "must be a valid pagination token",
      });
    }
  }

  return { errors, value: { limit, exclusiveStartKey } };
};

const toPickupContact = (pickupContact) => {
  if (!isPlainObject(pickupContact)) {
    return undefined;
  }

  return {
    name: pickupContact.name,
    phoneNumber: pickupContact.phoneNumber,
  };
};

const toOrderItem = (item) => ({
  dishId: item.dishId,
  name: item.name,
  category: item.category,
  quantity: item.quantity,
  unitPriceCents: item.unitPriceCents,
  lineTotalCents: item.lineTotalCents,
});

const toCustomerOrder = (order) => {
  const pickupContact = toPickupContact(order.pickupContact);

  return {
    orderId: order.orderId,
    status: order.status,
    fulfillment: order.fulfillment,
    ...(pickupContact ? { pickupContact } : {}),
    items: Array.isArray(order.items)
      ? order.items.filter(isPlainObject).map(toOrderItem)
      : [],
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
  };
};

const createListMyOrdersHandler = (dependencies = {}) => {
  const documentClient = dependencies.documentClient || getDocumentClient();
  const tableName = dependencies.tableName ?? process.env.ORDERS_TABLE;
  const indexName =
    dependencies.indexName ?? process.env.CUSTOMER_ORDERS_INDEX;
  const allowedOrigin =
    dependencies.allowedOrigin ?? process.env.CORS_ALLOWED_ORIGIN ?? "*";
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

    if (!tableName || !indexName) {
      logger.error("ORDERS_TABLE or CUSTOMER_ORDERS_INDEX is not configured");
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "Your orders could not be loaded.",
        allowedOrigin,
      );
    }

    const customerId = claims.sub.trim();
    const customerOrderKey = customerOrderKeyFor(customerId);
    const query = parseQuery(event, customerOrderKey);
    if (query.errors?.length > 0) {
      return errorResponse(
        400,
        "INVALID_QUERY",
        "The order-history query is invalid.",
        allowedOrigin,
        query.errors,
      );
    }

    try {
      const response = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: indexName,
          KeyConditionExpression:
            "#customerOrderKey = :customerOrderKey",
          ExpressionAttributeNames: {
            "#customerOrderKey": "customerOrderKey",
          },
          ExpressionAttributeValues: {
            ":customerOrderKey": customerOrderKey,
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
            item.customerId === customerId &&
            item.customerOrderKey === customerOrderKey &&
            typeof item.orderId === "string" &&
            item.orderId,
        )
        .map(toCustomerOrder);

      let nextToken = null;
      if (response.LastEvaluatedKey) {
        if (!isPaginationKey(response.LastEvaluatedKey, customerOrderKey)) {
          const error = new Error("Invalid DynamoDB pagination key");
          error.name = "InvalidPaginationKeyError";
          throw error;
        }
        nextToken = encodePaginationToken(response.LastEvaluatedKey);
      }

      return jsonResponse(200, { orders, nextToken }, allowedOrigin);
    } catch (error) {
      logger.error("Could not list customer orders", {
        errorName: error?.name,
        requestId: error?.$metadata?.requestId,
      });

      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "Your orders could not be loaded.",
        allowedOrigin,
      );
    }
  };
};

exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
exports.MAX_LIMIT = MAX_LIMIT;
exports.ORDER_ENTITY_TYPE = ORDER_ENTITY_TYPE;
exports.createListMyOrdersHandler = createListMyOrdersHandler;
exports.decodePaginationToken = decodePaginationToken;
exports.encodePaginationToken = encodePaginationToken;
exports.fn = createListMyOrdersHandler();
