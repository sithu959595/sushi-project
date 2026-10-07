"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { customerOrderKeyFor } = require("./order-keys");
const { validateMenuPayload } = require("./validate-menu");
const { validateOrderPayload } = require("./validate-order");

const MAX_BODY_BYTES = 64 * 1024;
const MENU_RECORD_ID = "MENU#CURRENT";
const ORDER_ENTITY_TYPE = "ORDER";
const IDEMPOTENCY_ENTITY_TYPE = "IDEMPOTENCY";
const ORDER_CREATED_EVENT = "ORDER_CREATED";
const INITIAL_ORDER_STATUS = "PENDING";
const INITIAL_NOTIFICATION_STATUS = "PENDING";
const CURRENCY = "USD";
const ORDERING_CONFIG_ID = "CONFIG#ORDERING";
const ORDERING_CONFIG_ENTITY_TYPE = "ORDERING_CONFIG";
const DEFAULT_PAUSED_MESSAGE = "Online ordering is temporarily paused.";
const MAX_ORDERING_MESSAGE_LENGTH = 300;

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

const requestHashFor = (value) =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const toPriceCents = (price) => {
  const [whole, fraction = ""] = price.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};

const toOrderResponse = (order, idempotentReplay = false) => ({
  orderId: order.orderId,
  status: order.status,
  notificationStatus: order.notificationStatus,
  fulfillment: order.fulfillment.toLowerCase(),
  currency: order.currency,
  itemCount: order.itemCount,
  subtotalCents: order.subtotalCents,
  totalCents: order.totalCents,
  createdAt: order.createdAt,
  ...(idempotentReplay ? { idempotentReplay: true } : {}),
});

const readClaimEmail = (claims) => {
  if (typeof claims.email !== "string") {
    return undefined;
  }

  const email = claims.email.trim();
  return email && email.length <= 320 ? email : undefined;
};

const idempotencyRecordId = (customerId, clientRequestId) =>
  `IDEMPOTENCY#${customerId}#${clientRequestId}`;

const isConditionalTransactionFailure = (error) =>
  error?.name === "TransactionCanceledException" ||
  error?.name === "ConditionalCheckFailedException";

const isOrderingConditionFailure = (error) =>
  Array.isArray(error?.CancellationReasons) &&
  error.CancellationReasons[0]?.Code === "ConditionalCheckFailed";

const isStoredOrderingConfig = (item) =>
  item?.orderId === ORDERING_CONFIG_ID &&
  item?.entityType === ORDERING_CONFIG_ENTITY_TYPE &&
  typeof item?.acceptingOrders === "boolean";

const orderingConfigFromCancellation = (error) => {
  const item = error?.CancellationReasons?.[0]?.Item;
  if (isStoredOrderingConfig(item)) {
    return item;
  }

  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }

  try {
    const unmarshalled = unmarshall(item);
    return isStoredOrderingConfig(unmarshalled)
      ? unmarshalled
      : undefined;
  } catch {
    return undefined;
  }
};

const pauseMessageFor = (item) => {
  if (
    isStoredOrderingConfig(item) &&
    typeof item.message === "string"
  ) {
    const message = item.message.trim();
    if (message && message.length <= MAX_ORDERING_MESSAGE_LENGTH) {
      return message;
    }
  }

  return DEFAULT_PAUSED_MESSAGE;
};

const createOrderHandler = (dependencies = {}) => {
  const documentClient = dependencies.documentClient || getDocumentClient();
  const dishesTableName =
    dependencies.dishesTableName ?? process.env.DISHES_TABLE;
  const ordersTableName =
    dependencies.ordersTableName ?? process.env.ORDERS_TABLE;
  const allowedOrigin =
    dependencies.allowedOrigin ?? process.env.CORS_ALLOWED_ORIGIN ?? "*";
  const now = dependencies.now || (() => new Date());
  const createUuid = dependencies.randomUUID || randomUUID;
  const logger = dependencies.logger || console;

  const loadExistingOrder = async ({
    customerId,
    clientRequestId,
    requestHash,
  }) => {
    const markerResponse = await documentClient.send(
      new GetCommand({
        TableName: ordersTableName,
        Key: {
          orderId: idempotencyRecordId(customerId, clientRequestId),
        },
        ConsistentRead: true,
      }),
    );
    const marker = markerResponse.Item;

    if (!marker) {
      return { type: "missing" };
    }

    if (
      marker.entityType !== IDEMPOTENCY_ENTITY_TYPE ||
      typeof marker.requestHash !== "string" ||
      typeof marker.referencedOrderId !== "string"
    ) {
      const error = new Error("Invalid stored idempotency record");
      error.name = "InvalidStoredOrderError";
      throw error;
    }

    if (marker.requestHash !== requestHash) {
      return { type: "conflict" };
    }

    const orderResponse = await documentClient.send(
      new GetCommand({
        TableName: ordersTableName,
        Key: { orderId: marker.referencedOrderId },
        ConsistentRead: true,
      }),
    );
    const order = orderResponse.Item;

    if (
      !order ||
      order.entityType !== ORDER_ENTITY_TYPE ||
      order.orderId !== marker.referencedOrderId
    ) {
      const error = new Error("Idempotency record refers to a missing order");
      error.name = "InvalidStoredOrderError";
      throw error;
    }

    return { type: "replay", order };
  };

  const loadOrderingConfiguration = async () => {
    const response = await documentClient.send(
      new GetCommand({
        TableName: ordersTableName,
        Key: { orderId: ORDERING_CONFIG_ID },
        ConsistentRead: true,
      }),
    );

    return response.Item;
  };

  const responseForExistingOrder = (existing) => {
    if (existing.type === "conflict") {
      return errorResponse(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This client request ID has already been used for a different order.",
        allowedOrigin,
      );
    }

    if (existing.type === "replay") {
      return jsonResponse(
        200,
        toOrderResponse(existing.order, true),
        allowedOrigin,
      );
    }

    return undefined;
  };

  return async (event) => {
    const claims = getClaims(event);
    if (typeof claims.sub !== "string" || !claims.sub.trim()) {
      return errorResponse(
        401,
        "UNAUTHORIZED",
        "A valid Cognito token is required.",
        allowedOrigin,
      );
    }

    if (!dishesTableName || !ordersTableName) {
      logger.error("DISHES_TABLE or ORDERS_TABLE is not configured");
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The pickup order could not be created.",
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

    const validation = validateOrderPayload(parsedBody.value);
    if (validation.errors.length > 0) {
      return errorResponse(
        422,
        "VALIDATION_ERROR",
        "The pickup order data is invalid.",
        allowedOrigin,
        validation.errors,
      );
    }

    const customerId = claims.sub.trim();
    const normalizedRequest = validation.value;
    const requestHash = requestHashFor(normalizedRequest);
    const idempotencyKey = idempotencyRecordId(
      customerId,
      normalizedRequest.clientRequestId,
    );

    try {
      const existing = await loadExistingOrder({
        customerId,
        clientRequestId: normalizedRequest.clientRequestId,
        requestHash,
      });
      const existingResponse = responseForExistingOrder(existing);
      if (existingResponse) {
        return existingResponse;
      }

      const menuResponse = await documentClient.send(
        new GetCommand({
          TableName: dishesTableName,
          Key: { id: MENU_RECORD_ID },
          ConsistentRead: true,
        }),
      );

      if (!menuResponse.Item) {
        return errorResponse(
          503,
          "MENU_UNAVAILABLE",
          "The live menu is unavailable. Please try again later.",
          allowedOrigin,
        );
      }

      const menuValidation = validateMenuPayload({
        items: menuResponse.Item.items,
      });
      if (menuValidation.errors.length > 0) {
        const error = new Error("Invalid stored menu");
        error.name = "InvalidStoredMenuError";
        throw error;
      }

      const menuById = new Map(
        menuValidation.value.items.map((dish) => [dish.id, dish]),
      );
      const unavailableItems = [];

      normalizedRequest.items.forEach(({ dishId }, index) => {
        const dish = menuById.get(dishId);
        if (!dish) {
          unavailableItems.push({
            field: `items[${index}].dishId`,
            message: "does not exist on the current menu",
            dishId,
            reason: "NOT_FOUND",
          });
        } else if (dish.availability !== "available") {
          unavailableItems.push({
            field: `items[${index}].dishId`,
            message: "is currently out",
            dishId,
            reason: "OUT",
          });
        }
      });

      if (unavailableItems.length > 0) {
        return errorResponse(
          409,
          "MENU_CHANGED",
          "Some dishes are no longer available.",
          allowedOrigin,
          unavailableItems,
        );
      }

      const orderItems = normalizedRequest.items.map(
        ({ dishId, quantity }) => {
          const dish = menuById.get(dishId);
          const unitPriceCents = toPriceCents(dish.price);

          return {
            dishId,
            name: dish.name,
            category: dish.category,
            quantity,
            unitPriceCents,
            lineTotalCents: unitPriceCents * quantity,
          };
        },
      );
      const itemCount = orderItems.reduce(
        (total, item) => total + item.quantity,
        0,
      );
      const subtotalCents = orderItems.reduce(
        (total, item) => total + item.lineTotalCents,
        0,
      );
      const currentTime = now();
      const date =
        currentTime instanceof Date ? currentTime : new Date(currentTime);
      const createdAt = date.toISOString();
      const orderId = `ord_${createUuid()}`;
      const customerEmail = readClaimEmail(claims);

      const order = {
        orderId,
        entityType: ORDER_ENTITY_TYPE,
        eventType: ORDER_CREATED_EVENT,
        status: INITIAL_ORDER_STATUS,
        notificationStatus: INITIAL_NOTIFICATION_STATUS,
        customerId,
        customerOrderKey: customerOrderKeyFor(customerId),
        ...(customerEmail ? { customerEmail } : {}),
        clientRequestId: normalizedRequest.clientRequestId,
        requestHash,
        fulfillment: "PICKUP",
        pickupContact: normalizedRequest.pickupContact,
        items: orderItems,
        itemCount,
        currency: CURRENCY,
        subtotalCents,
        totalCents: subtotalCents,
        customerNote: normalizedRequest.customerNote,
        createdAt,
        updatedAt: createdAt,
        ...(Number.isSafeInteger(menuResponse.Item.version)
          ? { menuVersion: menuResponse.Item.version }
          : {}),
      };
      const idempotencyMarker = {
        orderId: idempotencyKey,
        entityType: IDEMPOTENCY_ENTITY_TYPE,
        customerId,
        clientRequestId: normalizedRequest.clientRequestId,
        requestHash,
        referencedOrderId: orderId,
        createdAt,
      };

      try {
        await documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: ordersTableName,
                  Key: { orderId: ORDERING_CONFIG_ID },
                  ConditionExpression:
                    "attribute_not_exists(#orderId) OR " +
                    "(#entityType = :configType AND " +
                    "#acceptingOrders = :enabled)",
                  ExpressionAttributeNames: {
                    "#orderId": "orderId",
                    "#entityType": "entityType",
                    "#acceptingOrders": "acceptingOrders",
                  },
                  ExpressionAttributeValues: {
                    ":configType": ORDERING_CONFIG_ENTITY_TYPE,
                    ":enabled": true,
                  },
                  ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                },
              },
              {
                Put: {
                  TableName: ordersTableName,
                  Item: order,
                  ConditionExpression: "attribute_not_exists(#orderId)",
                  ExpressionAttributeNames: { "#orderId": "orderId" },
                },
              },
              {
                Put: {
                  TableName: ordersTableName,
                  Item: idempotencyMarker,
                  ConditionExpression: "attribute_not_exists(#orderId)",
                  ExpressionAttributeNames: { "#orderId": "orderId" },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (!isConditionalTransactionFailure(error)) {
          throw error;
        }

        const racedExisting = await loadExistingOrder({
          customerId,
          clientRequestId: normalizedRequest.clientRequestId,
          requestHash,
        });
        const racedResponse = responseForExistingOrder(racedExisting);
        if (racedResponse) {
          return racedResponse;
        }

        const failedConditionItem = orderingConfigFromCancellation(error);
        const orderingConfiguration = failedConditionItem
          ? failedConditionItem
          : await loadOrderingConfiguration();
        const orderingIsUnavailable =
          isOrderingConditionFailure(error) ||
          (orderingConfiguration &&
            (!isStoredOrderingConfig(orderingConfiguration) ||
              orderingConfiguration.acceptingOrders !== true));

        if (orderingIsUnavailable) {
          return errorResponse(
            503,
            "ORDERING_PAUSED",
            pauseMessageFor(orderingConfiguration),
            allowedOrigin,
          );
        }

        throw error;
      }

      return jsonResponse(201, toOrderResponse(order), allowedOrigin);
    } catch (error) {
      logger.error("Could not create pickup order", {
        errorName: error?.name,
        requestId: error?.$metadata?.requestId,
      });

      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The pickup order could not be created.",
        allowedOrigin,
      );
    }
  };
};

exports.CURRENCY = CURRENCY;
exports.DEFAULT_PAUSED_MESSAGE = DEFAULT_PAUSED_MESSAGE;
exports.IDEMPOTENCY_ENTITY_TYPE = IDEMPOTENCY_ENTITY_TYPE;
exports.INITIAL_NOTIFICATION_STATUS = INITIAL_NOTIFICATION_STATUS;
exports.INITIAL_ORDER_STATUS = INITIAL_ORDER_STATUS;
exports.MENU_RECORD_ID = MENU_RECORD_ID;
exports.ORDER_CREATED_EVENT = ORDER_CREATED_EVENT;
exports.ORDER_ENTITY_TYPE = ORDER_ENTITY_TYPE;
exports.ORDERING_CONFIG_ENTITY_TYPE = ORDERING_CONFIG_ENTITY_TYPE;
exports.ORDERING_CONFIG_ID = ORDERING_CONFIG_ID;
exports.createOrderHandler = createOrderHandler;
exports.fn = createOrderHandler();
