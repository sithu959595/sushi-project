"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_TOKEN_LENGTH = 2048;
const ORDER_ENTITY_TYPE = "ORDER";
const SUMMARY_RECORD_KEY = "SUMMARY";
const SUMMARY_RECORD_TYPE = "SUMMARY";
const FAILURE_RECORD_TYPE = "FAILURE";
const FAILURE_RECORD_KEY_PREFIX = "FAILURE#";
const ALLOWED_QUERY_FIELDS = new Set(["limit", "nextToken"]);
const ORDER_ID_PATTERN =
  /^ord_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

let sharedDocumentClient;

const getDocumentClient = () => {
  if (!sharedDocumentClient) {
    sharedDocumentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({}),
    );
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

const isCanonicalTimestamp = (value) => {
  if (typeof value !== "string") {
    return false;
  }

  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const isFailureRecordKey = (value) =>
  typeof value === "string" &&
  value.startsWith(FAILURE_RECORD_KEY_PREFIX) &&
  value.length <= 256;

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

const errorResponse = (
  statusCode,
  code,
  message,
  allowedOrigin,
  details,
) =>
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
    const value = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    );
    if (
      !isPlainObject(value) ||
      Object.keys(value).length !== 1 ||
      !isFailureRecordKey(value.recordKey)
    ) {
      return undefined;
    }

    return value.recordKey;
  } catch {
    return undefined;
  }
};

const encodePaginationToken = (recordKey) =>
  Buffer.from(JSON.stringify({ recordKey }), "utf8").toString(
    "base64url",
  );

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

  let exclusiveStartRecordKey;
  if (query.nextToken !== undefined) {
    exclusiveStartRecordKey = decodePaginationToken(query.nextToken);
    if (!exclusiveStartRecordKey) {
      errors.push({
        field: "nextToken",
        message: "must be a valid pagination token",
      });
    }
  }

  return {
    errors,
    value: { limit, exclusiveStartRecordKey },
  };
};

const toSummaryResponse = (summary, customerId) => {
  if (summary === undefined) {
    return { failedPickupCount: 0 };
  }

  if (
    !isPlainObject(summary) ||
    summary.customerId !== customerId ||
    summary.recordKey !== SUMMARY_RECORD_KEY ||
    summary.recordType !== SUMMARY_RECORD_TYPE ||
    !Number.isSafeInteger(summary.failedPickupCount) ||
    summary.failedPickupCount < 0
  ) {
    throw new Error("Invalid pickup-failure summary");
  }

  const hasLastFailure =
    ORDER_ID_PATTERN.test(summary.lastFailedOrderId || "") &&
    isCanonicalTimestamp(summary.lastFailedPickupAt);
  if (
    (summary.failedPickupCount > 0 && !hasLastFailure) ||
    (summary.failedPickupCount === 0 &&
      (summary.lastFailedOrderId !== undefined ||
        summary.lastFailedPickupAt !== undefined))
  ) {
    throw new Error("Invalid pickup-failure summary details");
  }

  return {
    failedPickupCount: summary.failedPickupCount,
    ...(hasLastFailure
      ? {
          lastFailedPickupAt: summary.lastFailedPickupAt,
          lastFailedOrderId: summary.lastFailedOrderId,
        }
      : {}),
  };
};

const toFailureResponse = (failure, customerId) => {
  if (
    !isPlainObject(failure) ||
    failure.customerId !== customerId ||
    failure.recordType !== FAILURE_RECORD_TYPE ||
    !ORDER_ID_PATTERN.test(failure.orderId || "") ||
    !isCanonicalTimestamp(failure.scheduledPickupTime) ||
    !isCanonicalTimestamp(failure.failedPickupAt) ||
    failure.recordKey !==
      `${FAILURE_RECORD_KEY_PREFIX}${failure.failedPickupAt}#${failure.orderId}`
  ) {
    throw new Error("Invalid pickup-failure record");
  }

  return {
    orderId: failure.orderId,
    scheduledPickupTime: failure.scheduledPickupTime,
    failedPickupAt: failure.failedPickupAt,
  };
};

const createGetCustomerPickupFailuresHandler = (dependencies = {}) => {
  const documentClient = dependencies.documentClient || getDocumentClient();
  const ordersTableName =
    dependencies.ordersTableName ?? process.env.ORDERS_TABLE;
  const pickupFailuresTableName =
    dependencies.pickupFailuresTableName ??
    process.env.CUSTOMER_PICKUP_FAILURES_TABLE;
  const adminGroupName =
    dependencies.adminGroupName ?? process.env.ADMIN_GROUP_NAME ?? "admin";
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

    if (!ordersTableName || !pickupFailuresTableName) {
      logger.error(
        "ORDERS_TABLE or CUSTOMER_PICKUP_FAILURES_TABLE is not configured",
      );
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The customer pickup history could not be loaded.",
        allowedOrigin,
      );
    }

    const orderId = event?.pathParameters?.orderId;
    if (typeof orderId !== "string" || !ORDER_ID_PATTERN.test(orderId)) {
      return errorResponse(
        400,
        "INVALID_ORDER_ID",
        "A valid order ID is required.",
        allowedOrigin,
      );
    }

    const query = parseQuery(event);
    if (query.errors?.length > 0) {
      return errorResponse(
        400,
        "INVALID_QUERY",
        "The pickup-history query is invalid.",
        allowedOrigin,
        query.errors,
      );
    }

    try {
      const orderResponse = await documentClient.send(
        new GetCommand({
          TableName: ordersTableName,
          Key: { orderId },
          ConsistentRead: true,
        }),
      );
      const order = orderResponse.Item;

      if (
        !isPlainObject(order) ||
        order.orderId !== orderId ||
        order.entityType !== ORDER_ENTITY_TYPE ||
        typeof order.customerId !== "string" ||
        !order.customerId.trim()
      ) {
        return errorResponse(
          404,
          "ORDER_NOT_FOUND",
          "The order could not be found.",
          allowedOrigin,
        );
      }

      const customerId = order.customerId.trim();
      const failuresResponse = await documentClient.send(
        new QueryCommand({
          TableName: pickupFailuresTableName,
          KeyConditionExpression:
            "#customerId = :customerId AND " +
            "begins_with(#recordKey, :failurePrefix)",
          ExpressionAttributeNames: {
            "#customerId": "customerId",
            "#recordKey": "recordKey",
          },
          ExpressionAttributeValues: {
            ":customerId": customerId,
            ":failurePrefix": FAILURE_RECORD_KEY_PREFIX,
          },
          ScanIndexForward: false,
          ConsistentRead: true,
          Limit: query.value.limit,
          ...(query.value.exclusiveStartRecordKey
            ? {
                ExclusiveStartKey: {
                  customerId,
                  recordKey: query.value.exclusiveStartRecordKey,
                },
              }
            : {}),
        }),
      );
      const summaryResponse = await documentClient.send(
        new GetCommand({
          TableName: pickupFailuresTableName,
          Key: {
            customerId,
            recordKey: SUMMARY_RECORD_KEY,
          },
          ConsistentRead: true,
        }),
      );

      const summary = toSummaryResponse(
        summaryResponse.Item,
        customerId,
      );
      const failures = (failuresResponse.Items || []).map((failure) =>
        toFailureResponse(failure, customerId),
      );
      if (summary.failedPickupCount < failures.length) {
        throw new Error("Pickup-failure count is inconsistent");
      }

      let nextToken = null;
      if (failuresResponse.LastEvaluatedKey) {
        const key = failuresResponse.LastEvaluatedKey;
        if (
          !isPlainObject(key) ||
          key.customerId !== customerId ||
          !isFailureRecordKey(key.recordKey)
        ) {
          throw new Error("Invalid DynamoDB pagination key");
        }
        nextToken = encodePaginationToken(key.recordKey);
      }

      return jsonResponse(
        200,
        {
          ...summary,
          failures,
          nextToken,
        },
        allowedOrigin,
      );
    } catch (error) {
      logger.error("Could not load customer pickup history", {
        errorName: error?.name,
        requestId: error?.$metadata?.requestId,
      });

      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The customer pickup history could not be loaded.",
        allowedOrigin,
      );
    }
  };
};

exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
exports.MAX_LIMIT = MAX_LIMIT;
exports.createGetCustomerPickupFailuresHandler =
  createGetCustomerPickupFailuresHandler;
exports.decodePaginationToken = decodePaginationToken;
exports.encodePaginationToken = encodePaginationToken;
exports.fn = createGetCustomerPickupFailuresHandler();
