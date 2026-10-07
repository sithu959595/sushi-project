"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const MAX_BODY_BYTES = 4 * 1024;
const MAX_RESTAURANT_NOTE_LENGTH = 500;
const ORDER_ENTITY_TYPE = "ORDER";
const ORDER_STATUSES = Object.freeze([
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "REJECTED",
  "FAILED_TO_PICKUP",
]);
const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  PENDING: new Set([
    "CONFIRMED",
    "CANCELLED",
    "REJECTED",
  ]),
  CONFIRMED: new Set(["CANCELLED", "FAILED_TO_PICKUP"]),
  CANCELLED: new Set(),
  REJECTED: new Set(),
  FAILED_TO_PICKUP: new Set(),
});
const BODY_FIELDS = new Set([
  "status",
  "expectedStatus",
  "pickupTime",
  "restaurantNote",
]);
const REQUIRED_BODY_FIELDS = Object.freeze(["status", "expectedStatus"]);
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

const validateStatusRequest = (payload) => {
  if (!isPlainObject(payload)) {
    return {
      errors: [{ field: "body", message: "must be a JSON object" }],
    };
  }

  const errors = [];
  Object.keys(payload).forEach((field) => {
    if (!BODY_FIELDS.has(field)) {
      errors.push({ field, message: "is not an allowed field" });
    }
  });

  for (const field of REQUIRED_BODY_FIELDS) {
    if (typeof payload[field] !== "string") {
      errors.push({ field, message: "must be a string" });
    } else if (!ORDER_STATUSES.includes(payload[field])) {
      errors.push({
        field,
        message: `must be one of: ${ORDER_STATUSES.join(", ")}`,
      });
    }
  }

  if (
    errors.length === 0 &&
    !ALLOWED_STATUS_TRANSITIONS[payload.expectedStatus].has(payload.status)
  ) {
    errors.push({
      field: "status",
      message: `cannot transition from ${payload.expectedStatus} to ${payload.status}`,
    });
  }

  let pickupTime;
  if (payload.status === "CONFIRMED") {
    if (typeof payload.pickupTime !== "string") {
      errors.push({
        field: "pickupTime",
        message: "must be a string when status is CONFIRMED",
      });
    } else if (!isCanonicalTimestamp(payload.pickupTime)) {
      errors.push({
        field: "pickupTime",
        message: "must be a canonical UTC timestamp",
      });
    } else {
      pickupTime = payload.pickupTime;
    }
  } else if (payload.pickupTime !== undefined) {
    errors.push({
      field: "pickupTime",
      message: "is only allowed when status is CONFIRMED",
    });
  }

  let restaurantNote = "";
  if (payload.restaurantNote !== undefined) {
    if (typeof payload.restaurantNote !== "string") {
      errors.push({
        field: "restaurantNote",
        message: "must be a string",
      });
    } else {
      restaurantNote = payload.restaurantNote.trim();
      if (restaurantNote.length > MAX_RESTAURANT_NOTE_LENGTH) {
        errors.push({
          field: "restaurantNote",
          message: `must not exceed ${MAX_RESTAURANT_NOTE_LENGTH} characters`,
        });
      }
    }
  }

  return {
    errors,
    value: {
      status: payload.status,
      expectedStatus: payload.expectedStatus,
      ...(pickupTime ? { pickupTime } : {}),
      restaurantNote,
    },
  };
};

const isConditionalCheckFailure = (error) =>
  error?.name === "ConditionalCheckFailedException" ||
  error?.code === "ConditionalCheckFailedException";

const toOrderResponse = (order) => ({
  orderId: order.orderId,
  status: order.status,
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
  ...(typeof order.restaurantNote === "string" && order.restaurantNote
    ? { restaurantNote: order.restaurantNote }
    : {}),
});

const isReturnedOrder = (order, orderId, status) =>
  isPlainObject(order) &&
  order.orderId === orderId &&
  order.entityType === ORDER_ENTITY_TYPE &&
  order.status === status &&
  typeof order.updatedAt === "string" &&
  Boolean(order.updatedAt);

const storedRestaurantNote = (order) =>
  typeof order?.restaurantNote === "string"
    ? order.restaurantNote.trim()
    : "";

const failureRecordKeyFor = (failedPickupAt, orderId) =>
  `FAILURE#${failedPickupAt}#${orderId}`;

const isRecordedFailedPickup = (
  order,
  orderId,
  restaurantNote,
) =>
  isReturnedOrder(order, orderId, "FAILED_TO_PICKUP") &&
  order.pickupTime === undefined &&
  isCanonicalTimestamp(order.scheduledPickupTime) &&
  isCanonicalTimestamp(order.failedToPickupAt) &&
  order.pickupFailureRecordKey ===
    failureRecordKeyFor(order.failedToPickupAt, orderId) &&
  typeof order.failedToPickupMarkedBy === "string" &&
  Boolean(order.failedToPickupMarkedBy.trim()) &&
  storedRestaurantNote(order) === restaurantNote;

const isValidNewerFailureSummary = (
  summary,
  customerId,
  failedToPickupAt,
) =>
  isPlainObject(summary) &&
  summary.customerId === customerId &&
  summary.recordKey === "SUMMARY" &&
  summary.recordType === "SUMMARY" &&
  Number.isSafeInteger(summary.failedPickupCount) &&
  summary.failedPickupCount > 0 &&
  ORDER_ID_PATTERN.test(summary.lastFailedOrderId || "") &&
  isCanonicalTimestamp(summary.lastFailedPickupAt) &&
  summary.lastFailedPickupAt > failedToPickupAt;

const hasMatchingStatusDetails = (
  order,
  { status, pickupTime, restaurantNote },
) =>
  (status === "CONFIRMED"
    ? order.pickupTime === pickupTime
    : order.pickupTime === undefined) &&
  storedRestaurantNote(order) === restaurantNote;

const createUpdateOrderStatusHandler = (dependencies = {}) => {
  const documentClient = dependencies.documentClient || getDocumentClient();
  const tableName = dependencies.tableName ?? process.env.ORDERS_TABLE;
  const pickupFailuresTableName =
    dependencies.pickupFailuresTableName ??
    process.env.CUSTOMER_PICKUP_FAILURES_TABLE;
  const adminGroupName =
    dependencies.adminGroupName ?? process.env.ADMIN_GROUP_NAME ?? "admin";
  const allowedOrigin =
    dependencies.allowedOrigin ?? process.env.CORS_ALLOWED_ORIGIN ?? "*";
  const now = dependencies.now || (() => new Date());
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

    if (!tableName) {
      logger.error("ORDERS_TABLE is not configured");
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The order status could not be updated.",
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

    const parsedBody = parseRequestBody(event);
    if (parsedBody.error) {
      return errorResponse(
        parsedBody.error.statusCode || 400,
        parsedBody.error.code,
        parsedBody.error.message,
        allowedOrigin,
      );
    }

    let requestDate;
    try {
      const currentTime = now();
      requestDate =
        currentTime instanceof Date
          ? currentTime
          : new Date(currentTime);
      if (Number.isNaN(requestDate.getTime())) {
        throw new Error("Invalid current time");
      }
    } catch (error) {
      logger.error("Could not determine the current time", {
        errorName: error?.name,
      });
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The order status could not be updated.",
        allowedOrigin,
      );
    }

    const validation = validateStatusRequest(parsedBody.value);
    if (validation.errors.length > 0) {
      return errorResponse(
        422,
        "VALIDATION_ERROR",
        "The order status data is invalid.",
        allowedOrigin,
        validation.errors,
      );
    }

    const {
      status,
      expectedStatus,
      pickupTime,
      restaurantNote,
    } = validation.value;
    const administratorId = claims.sub.trim();

    try {
      const updatedAt = requestDate.toISOString();
      const statusDetails = {
        status,
        pickupTime,
        restaurantNote,
      };

      if (status === "FAILED_TO_PICKUP") {
        if (!pickupFailuresTableName) {
          logger.error(
            "CUSTOMER_PICKUP_FAILURES_TABLE is not configured",
          );
          return errorResponse(
            500,
            "INTERNAL_ERROR",
            "The order status could not be updated.",
            allowedOrigin,
          );
        }

        const loadCurrentOrder = async () => {
          const currentResponse = await documentClient.send(
            new GetCommand({
              TableName: tableName,
              Key: { orderId },
              ConsistentRead: true,
            }),
          );
          return currentResponse.Item;
        };
        const statusConflictResponse = () =>
          errorResponse(
            409,
            "ORDER_STATUS_CONFLICT",
            "The order status has changed. Refresh the orders and try again.",
            allowedOrigin,
          );
        const currentOrder = await loadCurrentOrder();

        if (
          !isPlainObject(currentOrder) ||
          currentOrder.orderId !== orderId ||
          currentOrder.entityType !== ORDER_ENTITY_TYPE
        ) {
          return errorResponse(
            404,
            "ORDER_NOT_FOUND",
            "The order could not be found.",
            allowedOrigin,
          );
        }

        if (
          isRecordedFailedPickup(
            currentOrder,
            orderId,
            restaurantNote,
          )
        ) {
          return jsonResponse(
            200,
            { order: toOrderResponse(currentOrder) },
            allowedOrigin,
          );
        }

        if (currentOrder.status !== expectedStatus) {
          return statusConflictResponse();
        }

        if (
          typeof currentOrder.customerId !== "string" ||
          !currentOrder.customerId.trim() ||
          !isCanonicalTimestamp(currentOrder.pickupTime)
        ) {
          return errorResponse(
            409,
            "FAILED_PICKUP_NOT_ALLOWED",
            "The order does not have valid confirmed pickup details.",
            allowedOrigin,
          );
        }

        if (
          new Date(currentOrder.pickupTime).getTime() >
          requestDate.getTime()
        ) {
          return errorResponse(
            422,
            "PICKUP_TIME_NOT_REACHED",
            "The order cannot be marked as not picked up before its pickup time.",
            allowedOrigin,
          );
        }

        const customerId = currentOrder.customerId.trim();
        const scheduledPickupTime = currentOrder.pickupTime;
        const failedToPickupAt = updatedAt;
        const pickupFailureRecordKey = failureRecordKeyFor(
          failedToPickupAt,
          orderId,
        );
        const orderSetExpressions = [
          "#status = :status",
          "#updatedAt = :failedToPickupAt",
          "#statusUpdatedAt = :failedToPickupAt",
          "#statusUpdatedBy = :statusUpdatedBy",
          "#failedToPickupMarkedBy = :statusUpdatedBy",
          "#scheduledPickupTime = :scheduledPickupTime",
          "#failedToPickupAt = :failedToPickupAt",
          "#pickupFailureRecordKey = :pickupFailureRecordKey",
        ];
        const orderRemoveExpressions = ["#pickupTime"];
        const orderExpressionAttributeNames = {
          "#entityType": "entityType",
          "#status": "status",
          "#customerId": "customerId",
          "#updatedAt": "updatedAt",
          "#statusUpdatedAt": "statusUpdatedAt",
          "#statusUpdatedBy": "statusUpdatedBy",
          "#failedToPickupMarkedBy": "failedToPickupMarkedBy",
          "#pickupTime": "pickupTime",
          "#scheduledPickupTime": "scheduledPickupTime",
          "#failedToPickupAt": "failedToPickupAt",
          "#pickupFailureRecordKey": "pickupFailureRecordKey",
          "#restaurantNote": "restaurantNote",
        };
        const orderExpressionAttributeValues = {
          ":orderType": ORDER_ENTITY_TYPE,
          ":status": status,
          ":expectedStatus": expectedStatus,
          ":customerId": customerId,
          ":statusUpdatedBy": administratorId,
          ":scheduledPickupTime": scheduledPickupTime,
          ":failedToPickupAt": failedToPickupAt,
          ":pickupFailureRecordKey": pickupFailureRecordKey,
        };

        if (restaurantNote) {
          orderSetExpressions.push(
            "#restaurantNote = :restaurantNote",
          );
          orderExpressionAttributeValues[":restaurantNote"] =
            restaurantNote;
        } else {
          orderRemoveExpressions.push("#restaurantNote");
        }

        const failedOrder = {
          ...currentOrder,
          status,
          updatedAt,
          statusUpdatedAt: updatedAt,
          statusUpdatedBy: administratorId,
          failedToPickupMarkedBy: administratorId,
          scheduledPickupTime,
          failedToPickupAt,
          pickupFailureRecordKey,
          ...(restaurantNote ? { restaurantNote } : {}),
        };
        delete failedOrder.pickupTime;
        if (!restaurantNote) {
          delete failedOrder.restaurantNote;
        }

        const orderUpdate = {
          Update: {
            TableName: tableName,
            Key: { orderId },
            UpdateExpression: [
              `SET ${orderSetExpressions.join(", ")}`,
              `REMOVE ${orderRemoveExpressions.join(", ")}`,
            ].join(" "),
            ConditionExpression:
              "#entityType = :orderType AND " +
              "#status = :expectedStatus AND " +
              "#customerId = :customerId AND " +
              "#pickupTime = :scheduledPickupTime AND " +
              "#pickupTime <= :failedToPickupAt AND " +
              "attribute_not_exists(#failedToPickupAt) AND " +
              "attribute_not_exists(#pickupFailureRecordKey)",
            ExpressionAttributeNames:
              orderExpressionAttributeNames,
            ExpressionAttributeValues:
              orderExpressionAttributeValues,
          },
        };
        const failurePut = {
          Put: {
            TableName: pickupFailuresTableName,
            Item: {
              customerId,
              recordKey: pickupFailureRecordKey,
              recordType: "FAILURE",
              orderId,
              scheduledPickupTime,
              failedPickupAt: failedToPickupAt,
              createdAt: failedToPickupAt,
              recordedBy: administratorId,
            },
            ConditionExpression:
              "attribute_not_exists(#recordKey)",
            ExpressionAttributeNames: {
              "#recordKey": "recordKey",
            },
          },
        };
        const primarySummaryUpdate = {
          Update: {
            TableName: pickupFailuresTableName,
            Key: {
              customerId,
              recordKey: "SUMMARY",
            },
            UpdateExpression:
              "SET #recordType = if_not_exists(#recordType, :summaryType), " +
              "#createdAt = if_not_exists(#createdAt, :failedPickupAt), " +
              "#failedPickupCount = if_not_exists(#failedPickupCount, :zero) + :one, " +
              "#lastFailedOrderId = :orderId, " +
              "#lastFailedPickupAt = :failedPickupAt, " +
              "#updatedAt = :failedPickupAt",
            ConditionExpression:
              "(attribute_not_exists(#recordType) OR " +
              "#recordType = :summaryType) AND " +
              "(attribute_not_exists(#lastFailedPickupAt) OR " +
              "#lastFailedPickupAt <= :failedPickupAt)",
            ExpressionAttributeNames: {
              "#recordType": "recordType",
              "#createdAt": "createdAt",
              "#failedPickupCount": "failedPickupCount",
              "#lastFailedOrderId": "lastFailedOrderId",
              "#lastFailedPickupAt": "lastFailedPickupAt",
              "#updatedAt": "updatedAt",
            },
            ExpressionAttributeValues: {
              ":summaryType": "SUMMARY",
              ":zero": 0,
              ":one": 1,
              ":orderId": orderId,
              ":failedPickupAt": failedToPickupAt,
            },
          },
        };
        const writeFailureTransaction = (summaryUpdate) =>
          documentClient.send(
            new TransactWriteCommand({
              TransactItems: [
                orderUpdate,
                summaryUpdate,
                failurePut,
              ],
            }),
          );

        try {
          await writeFailureTransaction(primarySummaryUpdate);
        } catch (error) {
          if (
            error?.name !== "TransactionCanceledException" &&
            !isConditionalCheckFailure(error)
          ) {
            throw error;
          }

          const racedOrder = await loadCurrentOrder();
          if (
            !isPlainObject(racedOrder) ||
            racedOrder.orderId !== orderId ||
            racedOrder.entityType !== ORDER_ENTITY_TYPE
          ) {
            return errorResponse(
              404,
              "ORDER_NOT_FOUND",
              "The order could not be found.",
              allowedOrigin,
            );
          }

          if (
            isRecordedFailedPickup(
              racedOrder,
              orderId,
              restaurantNote,
            )
          ) {
            return jsonResponse(
              200,
              { order: toOrderResponse(racedOrder) },
              allowedOrigin,
            );
          }

          if (racedOrder.status === expectedStatus) {
            const summaryResponse = await documentClient.send(
              new GetCommand({
                TableName: pickupFailuresTableName,
                Key: {
                  customerId,
                  recordKey: "SUMMARY",
                },
                ConsistentRead: true,
              }),
            );
            const newerSummary = summaryResponse.Item;

            if (
              !isValidNewerFailureSummary(
                newerSummary,
                customerId,
                failedToPickupAt,
              )
            ) {
              throw error;
            }

            const preserveNewerSummaryUpdate = {
              Update: {
                TableName: pickupFailuresTableName,
                Key: {
                  customerId,
                  recordKey: "SUMMARY",
                },
                UpdateExpression:
                  "SET #failedPickupCount = #failedPickupCount + :one",
                ConditionExpression:
                  "#recordType = :summaryType AND " +
                  "#failedPickupCount >= :one AND " +
                  "attribute_type(#failedPickupCount, :numberType) AND " +
                  "#lastFailedOrderId = :newerLastFailedOrderId AND " +
                  "#lastFailedPickupAt = :newerLastFailedPickupAt AND " +
                  "#lastFailedPickupAt > :failedPickupAt",
                ExpressionAttributeNames: {
                  "#recordType": "recordType",
                  "#failedPickupCount": "failedPickupCount",
                  "#lastFailedOrderId": "lastFailedOrderId",
                  "#lastFailedPickupAt": "lastFailedPickupAt",
                },
                ExpressionAttributeValues: {
                  ":summaryType": "SUMMARY",
                  ":one": 1,
                  ":numberType": "N",
                  ":newerLastFailedOrderId":
                    newerSummary.lastFailedOrderId,
                  ":newerLastFailedPickupAt":
                    newerSummary.lastFailedPickupAt,
                  ":failedPickupAt": failedToPickupAt,
                },
              },
            };

            try {
              await writeFailureTransaction(
                preserveNewerSummaryUpdate,
              );
            } catch (retryError) {
              if (
                retryError?.name !==
                  "TransactionCanceledException" &&
                !isConditionalCheckFailure(retryError)
              ) {
                throw retryError;
              }

              const retriedOrder = await loadCurrentOrder();
              if (
                isRecordedFailedPickup(
                  retriedOrder,
                  orderId,
                  restaurantNote,
                )
              ) {
                return jsonResponse(
                  200,
                  { order: toOrderResponse(retriedOrder) },
                  allowedOrigin,
                );
              }

              if (
                !isPlainObject(retriedOrder) ||
                retriedOrder.orderId !== orderId ||
                retriedOrder.entityType !== ORDER_ENTITY_TYPE
              ) {
                return errorResponse(
                  404,
                  "ORDER_NOT_FOUND",
                  "The order could not be found.",
                  allowedOrigin,
                );
              }

              if (retriedOrder.status !== expectedStatus) {
                return statusConflictResponse();
              }

              throw retryError;
            }

            return jsonResponse(
              200,
              { order: toOrderResponse(failedOrder) },
              allowedOrigin,
            );
          }

          return statusConflictResponse();
        }

        return jsonResponse(
          200,
          { order: toOrderResponse(failedOrder) },
          allowedOrigin,
        );
      }

      if (
        status === "CONFIRMED" &&
        new Date(pickupTime).getTime() <= requestDate.getTime()
      ) {
        const currentResponse = await documentClient.send(
          new GetCommand({
            TableName: tableName,
            Key: { orderId },
            ConsistentRead: true,
          }),
        );
        const currentOrder = currentResponse.Item;

        if (
          isReturnedOrder(currentOrder, orderId, status) &&
          hasMatchingStatusDetails(currentOrder, statusDetails)
        ) {
          return jsonResponse(
            200,
            { order: toOrderResponse(currentOrder) },
            allowedOrigin,
          );
        }

        return errorResponse(
          422,
          "VALIDATION_ERROR",
          "The order status data is invalid.",
          allowedOrigin,
          [{ field: "pickupTime", message: "must be in the future" }],
        );
      }

      const setExpressions = [
        "#status = :status",
        "#updatedAt = :updatedAt",
        "#statusUpdatedAt = :updatedAt",
        "#statusUpdatedBy = :statusUpdatedBy",
      ];
      const removeExpressions = [];
      const expressionAttributeNames = {
        "#entityType": "entityType",
        "#status": "status",
        "#updatedAt": "updatedAt",
        "#statusUpdatedAt": "statusUpdatedAt",
        "#statusUpdatedBy": "statusUpdatedBy",
        "#pickupTime": "pickupTime",
        "#restaurantNote": "restaurantNote",
      };
      const expressionAttributeValues = {
        ":orderType": ORDER_ENTITY_TYPE,
        ":status": status,
        ":expectedStatus": expectedStatus,
        ":updatedAt": updatedAt,
        ":statusUpdatedBy": administratorId,
      };

      if (status === "CONFIRMED") {
        setExpressions.push("#pickupTime = :pickupTime");
        expressionAttributeValues[":pickupTime"] = pickupTime;
      } else {
        removeExpressions.push("#pickupTime");
      }

      if (restaurantNote) {
        setExpressions.push("#restaurantNote = :restaurantNote");
        expressionAttributeValues[":restaurantNote"] =
          restaurantNote;
      } else {
        removeExpressions.push("#restaurantNote");
      }

      const updateExpression = [
        `SET ${setExpressions.join(", ")}`,
        ...(removeExpressions.length > 0
          ? [`REMOVE ${removeExpressions.join(", ")}`]
          : []),
      ].join(" ");
      let response;

      try {
        response = await documentClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { orderId },
            UpdateExpression: updateExpression,
            ConditionExpression:
              "#entityType = :orderType AND #status = :expectedStatus",
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "ALL_NEW",
          }),
        );
      } catch (error) {
        if (!isConditionalCheckFailure(error)) {
          throw error;
        }

        const currentResponse = await documentClient.send(
          new GetCommand({
            TableName: tableName,
            Key: { orderId },
            ConsistentRead: true,
          }),
        );
        const currentOrder = currentResponse.Item;

        if (
          !isPlainObject(currentOrder) ||
          currentOrder.orderId !== orderId ||
          currentOrder.entityType !== ORDER_ENTITY_TYPE
        ) {
          return errorResponse(
            404,
            "ORDER_NOT_FOUND",
            "The order could not be found.",
            allowedOrigin,
          );
        }

        if (
          currentOrder.status === status &&
          hasMatchingStatusDetails(currentOrder, statusDetails)
        ) {
          if (!isReturnedOrder(currentOrder, orderId, status)) {
            throw new Error("Invalid stored order");
          }

          return jsonResponse(
            200,
            { order: toOrderResponse(currentOrder) },
            allowedOrigin,
          );
        }

        return errorResponse(
          409,
          "ORDER_STATUS_CONFLICT",
          "The order status has changed. Refresh the orders and try again.",
          allowedOrigin,
        );
      }

      if (!isReturnedOrder(response?.Attributes, orderId, status)) {
        throw new Error("DynamoDB returned an invalid updated order");
      }
      if (
        !hasMatchingStatusDetails(response.Attributes, statusDetails)
      ) {
        throw new Error(
          "DynamoDB returned mismatched order status details",
        );
      }

      return jsonResponse(
        200,
        { order: toOrderResponse(response.Attributes) },
        allowedOrigin,
      );
    } catch (error) {
      logger.error("Could not update order status", {
        errorName: error?.name,
        requestId: error?.$metadata?.requestId,
      });

      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The order status could not be updated.",
        allowedOrigin,
      );
    }
  };
};

exports.ALLOWED_STATUS_TRANSITIONS = ALLOWED_STATUS_TRANSITIONS;
exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
exports.MAX_RESTAURANT_NOTE_LENGTH = MAX_RESTAURANT_NOTE_LENGTH;
exports.ORDER_ENTITY_TYPE = ORDER_ENTITY_TYPE;
exports.ORDER_STATUSES = ORDER_STATUSES;
exports.createUpdateOrderStatusHandler = createUpdateOrderStatusHandler;
exports.fn = createUpdateOrderStatusHandler();
