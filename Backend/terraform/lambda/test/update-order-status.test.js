"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_BODY_BYTES,
  ORDER_STATUSES,
  createUpdateOrderStatusHandler,
} = require("../handler/update-order-status");

const ORDER_ID = "ord_550e8400-e29b-41d4-a716-446655440001";
const UPDATED_AT = "2026-07-23T18:30:00.000Z";
const PAST_PICKUP_TIME = "2026-07-23T18:00:00.000Z";
const PICKUP_TIME = "2026-07-23T19:30:00.000Z";
const RESTAURANT_NOTE = "Please come to the pickup counter.";
const CUSTOMER_ID = "customer-user-123";
const adminClaims = {
  sub: "admin-user-123",
  "cognito:groups": "customers,admin",
};
const silentLogger = { error() {} };

const statusBody = (
  status,
  expectedStatus,
  overrides = {},
) => ({
  status,
  expectedStatus,
  ...(status === "CONFIRMED" ? { pickupTime: PICKUP_TIME } : {}),
  ...overrides,
});

const eventFor = (
  body,
  claims = adminClaims,
  orderId = ORDER_ID,
) => ({
  body: typeof body === "string" ? body : JSON.stringify(body),
  pathParameters: { orderId },
  requestContext: { authorizer: { claims } },
});

const responseBody = (response) => JSON.parse(response.body);

const conditionalFailure = () => {
  const error = new Error("conditional update failed");
  error.name = "ConditionalCheckFailedException";
  return error;
};

const transactionFailure = () => {
  const error = new Error("transaction cancelled");
  error.name = "TransactionCanceledException";
  return error;
};

const buildHandler = (overrides = {}) => {
  const calls = [];
  const documentClient = overrides.documentClient || {
    async send(command) {
      calls.push({
        name: command.constructor.name,
        input: command.input,
      });

      if (command.constructor.name === "GetCommand") {
        return {
          Item: {
            orderId: ORDER_ID,
            entityType: "ORDER",
            status: "CONFIRMED",
            customerId: CUSTOMER_ID,
            pickupTime: PAST_PICKUP_TIME,
            updatedAt: UPDATED_AT,
          },
        };
      }

      if (command.constructor.name === "TransactWriteCommand") {
        return {};
      }

      const values = command.input.ExpressionAttributeValues;
      const status = values[":status"];
      return {
        Attributes: {
          orderId: ORDER_ID,
          entityType: "ORDER",
          status,
          updatedAt: UPDATED_AT,
          ...(values[":pickupTime"]
            ? { pickupTime: values[":pickupTime"] }
            : {}),
          ...(values[":restaurantNote"]
            ? { restaurantNote: values[":restaurantNote"] }
            : {}),
          customerId: "must-not-be-returned",
        },
      };
    },
  };

  return {
    calls,
    handler: createUpdateOrderStatusHandler({
      documentClient,
      tableName: "orders-test",
      pickupFailuresTableName: "pickup-failures-test",
      adminGroupName: "admin",
      allowedOrigin: "https://sushi.example",
      now: () => new Date(UPDATED_AT),
      logger: silentLogger,
      ...overrides,
    }),
  };
};

test("conditionally updates an existing order and returns a safe response", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor(
      statusBody("CONFIRMED", "PENDING", {
        restaurantNote: `  ${RESTAURANT_NOTE}  `,
      }),
    ),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(responseBody(response), {
    order: {
      orderId: ORDER_ID,
      status: "CONFIRMED",
      updatedAt: UPDATED_AT,
      pickupTime: PICKUP_TIME,
      restaurantNote: RESTAURANT_NOTE,
    },
  });
  assert.ok(!response.body.includes("customerId"));
  assert.deepEqual(calls, [
    {
      name: "UpdateCommand",
      input: {
        TableName: "orders-test",
        Key: { orderId: ORDER_ID },
        UpdateExpression:
          "SET #status = :status, #updatedAt = :updatedAt, " +
          "#statusUpdatedAt = :updatedAt, " +
          "#statusUpdatedBy = :statusUpdatedBy, " +
          "#pickupTime = :pickupTime, " +
          "#restaurantNote = :restaurantNote",
        ConditionExpression:
          "#entityType = :orderType AND #status = :expectedStatus",
        ExpressionAttributeNames: {
          "#entityType": "entityType",
          "#status": "status",
          "#updatedAt": "updatedAt",
          "#statusUpdatedAt": "statusUpdatedAt",
          "#statusUpdatedBy": "statusUpdatedBy",
          "#pickupTime": "pickupTime",
          "#restaurantNote": "restaurantNote",
        },
        ExpressionAttributeValues: {
          ":orderType": "ORDER",
          ":status": "CONFIRMED",
          ":expectedStatus": "PENDING",
          ":updatedAt": UPDATED_AT,
          ":statusUpdatedBy": adminClaims.sub,
          ":pickupTime": PICKUP_TIME,
          ":restaurantNote": RESTAURANT_NOTE,
        },
        ReturnValues: "ALL_NEW",
      },
    },
  ]);
});

test("removes confirmation details when moving away from CONFIRMED", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor(statusBody("CANCELLED", "CONFIRMED")),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), {
    order: {
      orderId: ORDER_ID,
      status: "CANCELLED",
      updatedAt: UPDATED_AT,
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].input.UpdateExpression,
    "SET #status = :status, #updatedAt = :updatedAt, " +
      "#statusUpdatedAt = :updatedAt, " +
      "#statusUpdatedBy = :statusUpdatedBy " +
      "REMOVE #pickupTime, #restaurantNote",
  );
  assert.ok(
    !Object.hasOwn(
      calls[0].input.ExpressionAttributeValues,
      ":pickupTime",
    ),
  );
  assert.ok(
    !Object.hasOwn(
      calls[0].input.ExpressionAttributeValues,
      ":restaurantNote",
    ),
  );
});

test("stores a trimmed note while removing pickup time on cancellation", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor(
      statusBody("CANCELLED", "CONFIRMED", {
        restaurantNote: `  ${RESTAURANT_NOTE}  `,
      }),
    ),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), {
    order: {
      orderId: ORDER_ID,
      status: "CANCELLED",
      updatedAt: UPDATED_AT,
      restaurantNote: RESTAURANT_NOTE,
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].input.UpdateExpression,
    "SET #status = :status, #updatedAt = :updatedAt, " +
      "#statusUpdatedAt = :updatedAt, " +
      "#statusUpdatedBy = :statusUpdatedBy, " +
      "#restaurantNote = :restaurantNote " +
      "REMOVE #pickupTime",
  );
  assert.equal(
    calls[0].input.ExpressionAttributeValues[":restaurantNote"],
    RESTAURANT_NOTE,
  );
  assert.ok(
    !Object.hasOwn(
      calls[0].input.ExpressionAttributeValues,
      ":pickupTime",
    ),
  );
});

test("enforces every status-transition rule before DynamoDB", async () => {
  const allowed = new Set([
    "PENDING->CONFIRMED",
    "PENDING->CANCELLED",
    "PENDING->REJECTED",
    "CONFIRMED->CANCELLED",
    "CONFIRMED->FAILED_TO_PICKUP",
  ]);

  assert.deepEqual(ORDER_STATUSES, [
    "PENDING",
    "CONFIRMED",
    "CANCELLED",
    "REJECTED",
    "FAILED_TO_PICKUP",
  ]);

  for (const expectedStatus of ORDER_STATUSES) {
    for (const status of ORDER_STATUSES) {
      const transition = `${expectedStatus}->${status}`;
      const { handler, calls } = buildHandler();
      const response = await handler(
        eventFor(statusBody(status, expectedStatus)),
      );

      if (allowed.has(transition)) {
        assert.equal(response.statusCode, 200, transition);
        assert.equal(
          calls.length,
          status === "FAILED_TO_PICKUP" ? 2 : 1,
          transition,
        );
      } else {
        assert.equal(response.statusCode, 422, transition);
        assert.equal(
          responseBody(response).error.code,
          "VALIDATION_ERROR",
          transition,
        );
        assert.equal(calls.length, 0, transition);
      }
    }
  }
});

test("atomically records a failed pickup and returns a safe response", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor(
      statusBody("FAILED_TO_PICKUP", "CONFIRMED", {
        restaurantNote: `  ${RESTAURANT_NOTE}  `,
      }),
    ),
  );
  const failureRecordKey =
    `FAILURE#${UPDATED_AT}#${ORDER_ID}`;

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), {
    order: {
      orderId: ORDER_ID,
      status: "FAILED_TO_PICKUP",
      updatedAt: UPDATED_AT,
      scheduledPickupTime: PAST_PICKUP_TIME,
      failedToPickupAt: UPDATED_AT,
      restaurantNote: RESTAURANT_NOTE,
    },
  });
  assert.ok(!response.body.includes("customerId"));
  assert.ok(!response.body.includes("pickupFailureRecordKey"));
  assert.ok(!response.body.includes("failedToPickupMarkedBy"));
  assert.ok(!response.body.includes("recordedBy"));
  assert.deepEqual(calls[0], {
    name: "GetCommand",
    input: {
      TableName: "orders-test",
      Key: { orderId: ORDER_ID },
      ConsistentRead: true,
    },
  });
  assert.equal(calls[1].name, "TransactWriteCommand");
  assert.deepEqual(calls[1].input.TransactItems, [
    {
      Update: {
        TableName: "orders-test",
        Key: { orderId: ORDER_ID },
        UpdateExpression:
          "SET #status = :status, " +
          "#updatedAt = :failedToPickupAt, " +
          "#statusUpdatedAt = :failedToPickupAt, " +
          "#statusUpdatedBy = :statusUpdatedBy, " +
          "#failedToPickupMarkedBy = :statusUpdatedBy, " +
          "#scheduledPickupTime = :scheduledPickupTime, " +
          "#failedToPickupAt = :failedToPickupAt, " +
          "#pickupFailureRecordKey = :pickupFailureRecordKey, " +
          "#restaurantNote = :restaurantNote " +
          "REMOVE #pickupTime",
        ConditionExpression:
          "#entityType = :orderType AND " +
          "#status = :expectedStatus AND " +
          "#customerId = :customerId AND " +
          "#pickupTime = :scheduledPickupTime AND " +
          "#pickupTime <= :failedToPickupAt AND " +
          "attribute_not_exists(#failedToPickupAt) AND " +
          "attribute_not_exists(#pickupFailureRecordKey)",
        ExpressionAttributeNames: {
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
        },
        ExpressionAttributeValues: {
          ":orderType": "ORDER",
          ":status": "FAILED_TO_PICKUP",
          ":expectedStatus": "CONFIRMED",
          ":customerId": CUSTOMER_ID,
          ":statusUpdatedBy": adminClaims.sub,
          ":scheduledPickupTime": PAST_PICKUP_TIME,
          ":failedToPickupAt": UPDATED_AT,
          ":pickupFailureRecordKey": failureRecordKey,
          ":restaurantNote": RESTAURANT_NOTE,
        },
      },
    },
    {
      Update: {
        TableName: "pickup-failures-test",
        Key: {
          customerId: CUSTOMER_ID,
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
          ":orderId": ORDER_ID,
          ":failedPickupAt": UPDATED_AT,
        },
      },
    },
    {
      Put: {
        TableName: "pickup-failures-test",
        Item: {
          customerId: CUSTOMER_ID,
          recordKey: failureRecordKey,
          recordType: "FAILURE",
          orderId: ORDER_ID,
          scheduledPickupTime: PAST_PICKUP_TIME,
          failedPickupAt: UPDATED_AT,
          createdAt: UPDATED_AT,
          recordedBy: adminClaims.sub,
        },
        ConditionExpression: "attribute_not_exists(#recordKey)",
        ExpressionAttributeNames: {
          "#recordKey": "recordKey",
        },
      },
    },
  ]);
});

test("removes the active pickup time and an empty note for a failed pickup", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor(statusBody("FAILED_TO_PICKUP", "CONFIRMED")),
  );

  assert.equal(response.statusCode, 200);
  assert.ok(!Object.hasOwn(responseBody(response).order, "pickupTime"));
  assert.ok(
    !Object.hasOwn(responseBody(response).order, "restaurantNote"),
  );
  assert.equal(
    calls[1].input.TransactItems[0].Update.UpdateExpression.endsWith(
      "REMOVE #pickupTime, #restaurantNote",
    ),
    true,
  );
});

test("uses server time and stored order identity to validate a failed pickup", async () => {
  const invalidOrders = [
    {
      customerId: "",
      pickupTime: PAST_PICKUP_TIME,
    },
    {
      customerId: CUSTOMER_ID,
    },
    {
      customerId: CUSTOMER_ID,
      pickupTime: "2026-07-23T11:00:00.000-07:00",
    },
  ];

  for (const invalidDetails of invalidOrders) {
    const calls = [];
    const documentClient = {
      async send(command) {
        calls.push(command);
        return {
          Item: {
            orderId: ORDER_ID,
            entityType: "ORDER",
            status: "CONFIRMED",
            updatedAt: UPDATED_AT,
            ...invalidDetails,
          },
        };
      },
    };
    const { handler } = buildHandler({ documentClient });
    const response = await handler(
      eventFor(statusBody("FAILED_TO_PICKUP", "CONFIRMED")),
    );

    assert.equal(response.statusCode, 409);
    assert.equal(
      responseBody(response).error.code,
      "FAILED_PICKUP_NOT_ALLOWED",
    );
    assert.equal(calls.length, 1);
  }

  const futureCalls = [];
  const futureClient = {
    async send(command) {
      futureCalls.push(command);
      return {
        Item: {
          orderId: ORDER_ID,
          entityType: "ORDER",
          status: "CONFIRMED",
          customerId: CUSTOMER_ID,
          pickupTime: PICKUP_TIME,
          updatedAt: UPDATED_AT,
        },
      };
    },
  };
  const { handler: futureHandler } = buildHandler({
    documentClient: futureClient,
  });
  const futureResponse = await futureHandler(
    eventFor(statusBody("FAILED_TO_PICKUP", "CONFIRMED")),
  );

  assert.equal(futureResponse.statusCode, 422);
  assert.equal(
    responseBody(futureResponse).error.code,
    "PICKUP_TIME_NOT_REACHED",
  );
  assert.equal(futureCalls.length, 1);
});

test("accepts an exact failed-pickup retry without incrementing again", async () => {
  const failureRecordKey =
    `FAILURE#${UPDATED_AT}#${ORDER_ID}`;
  const calls = [];
  const documentClient = {
    async send(command) {
      calls.push(command);
      return {
        Item: {
          orderId: ORDER_ID,
          entityType: "ORDER",
          status: "FAILED_TO_PICKUP",
          updatedAt: UPDATED_AT,
          scheduledPickupTime: PAST_PICKUP_TIME,
          failedToPickupAt: UPDATED_AT,
          pickupFailureRecordKey: failureRecordKey,
          failedToPickupMarkedBy: "admin-user-123",
          restaurantNote: RESTAURANT_NOTE,
          statusUpdatedBy: "must-not-be-returned",
          customerId: CUSTOMER_ID,
        },
      };
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(
    eventFor(
      statusBody("FAILED_TO_PICKUP", "CONFIRMED", {
        restaurantNote: ` ${RESTAURANT_NOTE} `,
      }),
    ),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].constructor.name, "GetCommand");
  assert.ok(!response.body.includes("pickupFailureRecordKey"));
  assert.ok(!response.body.includes("customerId"));
  assert.ok(!response.body.includes("statusUpdatedBy"));
  assert.ok(!response.body.includes("failedToPickupMarkedBy"));
});

test("handles failed-pickup transaction races without double counting", async () => {
  const failureRecordKey =
    `FAILURE#${UPDATED_AT}#${ORDER_ID}`;
  let callCount = 0;
  const exactRetryClient = {
    async send(command) {
      callCount += 1;
      if (command.constructor.name === "TransactWriteCommand") {
        throw transactionFailure();
      }
      if (callCount === 1) {
        return {
          Item: {
            orderId: ORDER_ID,
            entityType: "ORDER",
            status: "CONFIRMED",
            customerId: CUSTOMER_ID,
            pickupTime: PAST_PICKUP_TIME,
            updatedAt: UPDATED_AT,
          },
        };
      }
      return {
        Item: {
          orderId: ORDER_ID,
          entityType: "ORDER",
          status: "FAILED_TO_PICKUP",
          updatedAt: UPDATED_AT,
          scheduledPickupTime: PAST_PICKUP_TIME,
          failedToPickupAt: UPDATED_AT,
          pickupFailureRecordKey: failureRecordKey,
          failedToPickupMarkedBy: "admin-user-123",
          restaurantNote: RESTAURANT_NOTE,
        },
      };
    },
  };
  const { handler: retryHandler } = buildHandler({
    documentClient: exactRetryClient,
  });
  const retryResponse = await retryHandler(
    eventFor(
      statusBody("FAILED_TO_PICKUP", "CONFIRMED", {
        restaurantNote: RESTAURANT_NOTE,
      }),
    ),
  );
  assert.equal(retryResponse.statusCode, 200);
  assert.equal(callCount, 3);

  let conflictCalls = 0;
  const conflictClient = {
    async send(command) {
      conflictCalls += 1;
      if (command.constructor.name === "TransactWriteCommand") {
        throw transactionFailure();
      }
      if (conflictCalls === 1) {
        return {
          Item: {
            orderId: ORDER_ID,
            entityType: "ORDER",
            status: "CONFIRMED",
            customerId: CUSTOMER_ID,
            pickupTime: PAST_PICKUP_TIME,
            updatedAt: UPDATED_AT,
          },
        };
      }
      return {
        Item: {
          orderId: ORDER_ID,
          entityType: "ORDER",
          status: "FAILED_TO_PICKUP",
          updatedAt: UPDATED_AT,
          scheduledPickupTime: PAST_PICKUP_TIME,
          failedToPickupAt: UPDATED_AT,
          pickupFailureRecordKey: failureRecordKey,
          failedToPickupMarkedBy: "admin-user-123",
          restaurantNote: "A different note.",
        },
      };
    },
  };
  const { handler: conflictHandler } = buildHandler({
    documentClient: conflictClient,
  });
  const conflictResponse = await conflictHandler(
    eventFor(
      statusBody("FAILED_TO_PICKUP", "CONFIRMED", {
        restaurantNote: RESTAURANT_NOTE,
      }),
    ),
  );
  assert.equal(conflictResponse.statusCode, 409);
  assert.equal(
    responseBody(conflictResponse).error.code,
    "ORDER_STATUS_CONFLICT",
  );
  assert.equal(conflictCalls, 3);
});

test("preserves a newer failure summary while atomically recording an older concurrent failure", async () => {
  const newerFailedPickupAt = "2026-07-23T18:31:00.000Z";
  const newerOrderId =
    "ord_550e8400-e29b-41d4-a716-446655440002";
  const calls = [];
  let transactionCount = 0;
  const documentClient = {
    async send(command) {
      calls.push({
        name: command.constructor.name,
        input: command.input,
      });

      if (command.constructor.name === "TransactWriteCommand") {
        transactionCount += 1;
        if (transactionCount === 1) {
          throw transactionFailure();
        }
        return {};
      }

      if (command.input.TableName === "pickup-failures-test") {
        return {
          Item: {
            customerId: CUSTOMER_ID,
            recordKey: "SUMMARY",
            recordType: "SUMMARY",
            failedPickupCount: 1,
            lastFailedOrderId: newerOrderId,
            lastFailedPickupAt: newerFailedPickupAt,
          },
        };
      }

      return {
        Item: {
          orderId: ORDER_ID,
          entityType: "ORDER",
          status: "CONFIRMED",
          customerId: CUSTOMER_ID,
          pickupTime: PAST_PICKUP_TIME,
          updatedAt: UPDATED_AT,
        },
      };
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(
    eventFor(statusBody("FAILED_TO_PICKUP", "CONFIRMED")),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 5);
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "GetCommand",
      "TransactWriteCommand",
      "GetCommand",
      "GetCommand",
      "TransactWriteCommand",
    ],
  );
  assert.deepEqual(calls[3].input, {
    TableName: "pickup-failures-test",
    Key: {
      customerId: CUSTOMER_ID,
      recordKey: "SUMMARY",
    },
    ConsistentRead: true,
  });

  const fallbackItems = calls[4].input.TransactItems;
  assert.equal(
    fallbackItems[0].Update.ExpressionAttributeValues[
      ":statusUpdatedBy"
    ],
    adminClaims.sub,
  );
  assert.equal(
    fallbackItems[0].Update.ExpressionAttributeNames[
      "#failedToPickupMarkedBy"
    ],
    "failedToPickupMarkedBy",
  );
  assert.equal(
    fallbackItems[2].Put.Item.recordedBy,
    adminClaims.sub,
  );
  assert.deepEqual(fallbackItems[1], {
    Update: {
      TableName: "pickup-failures-test",
      Key: {
        customerId: CUSTOMER_ID,
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
        ":newerLastFailedOrderId": newerOrderId,
        ":newerLastFailedPickupAt": newerFailedPickupAt,
        ":failedPickupAt": UPDATED_AT,
      },
    },
  });
  assert.ok(!response.body.includes(adminClaims.sub));
});

test("does not retry a cancelled failed-pickup transaction without a valid strictly newer summary", async () => {
  const invalidSummaries = [
    undefined,
    {
      customerId: CUSTOMER_ID,
      recordKey: "SUMMARY",
      recordType: "SUMMARY",
      failedPickupCount: 1,
      lastFailedOrderId:
        "ord_550e8400-e29b-41d4-a716-446655440002",
      lastFailedPickupAt: UPDATED_AT,
    },
    {
      customerId: CUSTOMER_ID,
      recordKey: "SUMMARY",
      recordType: "SUMMARY",
      failedPickupCount: 0,
      lastFailedOrderId:
        "ord_550e8400-e29b-41d4-a716-446655440002",
      lastFailedPickupAt: "2026-07-23T18:31:00.000Z",
    },
    {
      customerId: "another-customer",
      recordKey: "SUMMARY",
      recordType: "SUMMARY",
      failedPickupCount: 1,
      lastFailedOrderId:
        "ord_550e8400-e29b-41d4-a716-446655440002",
      lastFailedPickupAt: "2026-07-23T18:31:00.000Z",
    },
  ];

  for (const summary of invalidSummaries) {
    const calls = [];
    const documentClient = {
      async send(command) {
        calls.push(command.constructor.name);
        if (command.constructor.name === "TransactWriteCommand") {
          throw transactionFailure();
        }
        if (
          command.input.TableName === "pickup-failures-test"
        ) {
          return summary ? { Item: structuredClone(summary) } : {};
        }
        return {
          Item: {
            orderId: ORDER_ID,
            entityType: "ORDER",
            status: "CONFIRMED",
            customerId: CUSTOMER_ID,
            pickupTime: PAST_PICKUP_TIME,
            updatedAt: UPDATED_AT,
          },
        };
      },
    };
    const { handler } = buildHandler({ documentClient });
    const response = await handler(
      eventFor(statusBody("FAILED_TO_PICKUP", "CONFIRMED")),
    );

    assert.equal(response.statusCode, 500, JSON.stringify(summary));
    assert.equal(
      responseBody(response).error.code,
      "INTERNAL_ERROR",
      JSON.stringify(summary),
    );
    assert.deepEqual(
      calls,
      [
        "GetCommand",
        "TransactWriteCommand",
        "GetCommand",
        "GetCommand",
      ],
      JSON.stringify(summary),
    );
  }
});

test("keeps a cancelled summary-preserving retry atomic when ambiguity remains", async () => {
  let transactionCount = 0;
  const calls = [];
  const documentClient = {
    async send(command) {
      calls.push(command.constructor.name);
      if (command.constructor.name === "TransactWriteCommand") {
        transactionCount += 1;
        throw transactionFailure();
      }
      if (command.input.TableName === "pickup-failures-test") {
        return {
          Item: {
            customerId: CUSTOMER_ID,
            recordKey: "SUMMARY",
            recordType: "SUMMARY",
            failedPickupCount: 1,
            lastFailedOrderId:
              "ord_550e8400-e29b-41d4-a716-446655440002",
            lastFailedPickupAt: "2026-07-23T18:31:00.000Z",
          },
        };
      }
      return {
        Item: {
          orderId: ORDER_ID,
          entityType: "ORDER",
          status: "CONFIRMED",
          customerId: CUSTOMER_ID,
          pickupTime: PAST_PICKUP_TIME,
          updatedAt: UPDATED_AT,
        },
      };
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(
    eventFor(statusBody("FAILED_TO_PICKUP", "CONFIRMED")),
  );

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.equal(transactionCount, 2);
  assert.deepEqual(calls, [
    "GetCommand",
    "TransactWriteCommand",
    "GetCommand",
    "GetCommand",
    "TransactWriteCommand",
    "GetCommand",
  ]);
});

test("does not hide a failed-pickup transaction error when the order is unchanged", async () => {
  let calls = 0;
  const documentClient = {
    async send(command) {
      calls += 1;
      if (command.constructor.name === "TransactWriteCommand") {
        throw transactionFailure();
      }
      return {
        Item: {
          orderId: ORDER_ID,
          entityType: "ORDER",
          status: "CONFIRMED",
          customerId: CUSTOMER_ID,
          pickupTime: PAST_PICKUP_TIME,
          updatedAt: UPDATED_AT,
        },
      };
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(
    eventFor(statusBody("FAILED_TO_PICKUP", "CONFIRMED")),
  );

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.equal(calls, 4);
});

test("requires a Cognito identity and the configured admin group", async () => {
  const { handler, calls } = buildHandler();
  const body = statusBody("CONFIRMED", "PENDING");

  const unauthenticated = await handler(eventFor(body, {}));
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(responseBody(unauthenticated).error.code, "UNAUTHORIZED");

  const emptySub = await handler(
    eventFor(body, {
      sub: " ",
      "cognito:groups": "admin",
    }),
  );
  assert.equal(emptySub.statusCode, 401);

  const customer = await handler(
    eventFor(body, {
      sub: "customer-user",
      "cognito:groups": "customers",
    }),
  );
  assert.equal(customer.statusCode, 403);
  assert.equal(responseBody(customer).error.code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("supports HTTP API claims and common Cognito group formats", async () => {
  for (const groups of [
    ["customers", "admin"],
    "[\"customers\",\"admin\"]",
    "customers, admin",
  ]) {
    const { handler } = buildHandler();
    const event = eventFor(statusBody("CONFIRMED", "PENDING"));
    event.requestContext.authorizer = {
      jwt: {
        claims: {
          sub: adminClaims.sub,
          "cognito:groups": groups,
        },
      },
    };

    const response = await handler(event);
    assert.equal(response.statusCode, 200, JSON.stringify(groups));
  }
});

test("requires the project UUID order ID format", async () => {
  for (const orderId of [
    undefined,
    "",
    "550e8400-e29b-41d4-a716-446655440001",
    "ord_not-a-uuid",
    "ord_550e8400-e29b-41d4-a716-446655440001-extra",
    " ord_550e8400-e29b-41d4-a716-446655440001 ",
    "IDEMPOTENCY#customer#request",
  ]) {
    const { handler, calls } = buildHandler();
    const event = eventFor(
      statusBody("CONFIRMED", "PENDING"),
      adminClaims,
      orderId,
    );
    if (orderId === undefined) {
      event.pathParameters = {};
    }

    const response = await handler(event);
    assert.equal(response.statusCode, 400, String(orderId));
    assert.equal(
      responseBody(response).error.code,
      "INVALID_ORDER_ID",
      String(orderId),
    );
    assert.equal(calls.length, 0, String(orderId));
  }
});

test("validates status details and rejects unknown fields", async () => {
  const invalidBodies = [
    null,
    [],
    "[]",
    {},
    { status: "CONFIRMED" },
    { expectedStatus: "PENDING" },
    {
      status: "CONFIRMED",
      expectedStatus: "PENDING",
      pickupTime: PICKUP_TIME,
      orderId: ORDER_ID,
    },
    { status: 4, expectedStatus: "PENDING" },
    { status: "confirmed", expectedStatus: "PENDING" },
    { status: "READY", expectedStatus: "PENDING" },
    { status: "CONFIRMED", expectedStatus: "pending" },
    {
      status: "CONFIRMED",
      expectedStatus: "PENDING",
      pickupTime: 123,
    },
    {
      status: "CONFIRMED",
      expectedStatus: "PENDING",
      pickupTime: "2026-07-23T12:30:00.000-07:00",
    },
    {
      status: "CANCELLED",
      expectedStatus: "PENDING",
      pickupTime: PICKUP_TIME,
    },
    statusBody("CONFIRMED", "PENDING", {
      restaurantNote: 123,
    }),
    statusBody("CONFIRMED", "PENDING", {
      restaurantNote: "x".repeat(501),
    }),
  ];

  for (const body of invalidBodies) {
    const { handler, calls } = buildHandler();
    const eventBody = body === "[]" ? body : body;
    const response = await handler(eventFor(eventBody));

    assert.equal(response.statusCode, 422, JSON.stringify(body));
    assert.equal(
      responseBody(response).error.code,
      "VALIDATION_ERROR",
      JSON.stringify(body),
    );
    assert.equal(calls.length, 0, JSON.stringify(body));
  }
});

test("rejects a past pickup time after a consistent retry check", async () => {
  const calls = [];
  const documentClient = {
    async send(command) {
      calls.push({
        name: command.constructor.name,
        input: command.input,
      });
      return {
        Item: {
          orderId: ORDER_ID,
          entityType: "ORDER",
          status: "CONFIRMED",
          updatedAt: "2026-07-23T17:30:00.000Z",
          pickupTime: PAST_PICKUP_TIME,
          restaurantNote: "A different note.",
        },
      };
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(
    eventFor(
      statusBody("CONFIRMED", "PENDING", {
        pickupTime: PAST_PICKUP_TIME,
        restaurantNote: RESTAURANT_NOTE,
      }),
    ),
  );

  assert.equal(response.statusCode, 422);
  assert.equal(responseBody(response).error.code, "VALIDATION_ERROR");
  assert.deepEqual(responseBody(response).error.details, [
    { field: "pickupTime", message: "must be in the future" },
  ]);
  assert.deepEqual(calls, [
    {
      name: "GetCommand",
      input: {
        TableName: "orders-test",
        Key: { orderId: ORDER_ID },
        ConsistentRead: true,
      },
    },
  ]);
});

test("accepts an exact past pickup-time retry without issuing an update", async () => {
  const calls = [];
  const storedUpdatedAt = "2026-07-23T17:30:00.000Z";
  const documentClient = {
    async send(command) {
      calls.push({
        name: command.constructor.name,
        input: command.input,
      });
      return {
        Item: {
          orderId: ORDER_ID,
          entityType: "ORDER",
          status: "CONFIRMED",
          updatedAt: storedUpdatedAt,
          pickupTime: PAST_PICKUP_TIME,
          restaurantNote: RESTAURANT_NOTE,
          statusUpdatedBy: "another-admin",
          customerId: "must-not-be-returned",
        },
      };
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(
    eventFor(
      statusBody("CONFIRMED", "PENDING", {
        pickupTime: PAST_PICKUP_TIME,
        restaurantNote: ` ${RESTAURANT_NOTE} `,
      }),
    ),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), {
    order: {
      orderId: ORDER_ID,
      status: "CONFIRMED",
      updatedAt: storedUpdatedAt,
      pickupTime: PAST_PICKUP_TIME,
      restaurantNote: RESTAURANT_NOTE,
    },
  });
  assert.ok(!response.body.includes("statusUpdatedBy"));
  assert.ok(!response.body.includes("customerId"));
  assert.deepEqual(calls, [
    {
      name: "GetCommand",
      input: {
        TableName: "orders-test",
        Key: { orderId: ORDER_ID },
        ConsistentRead: true,
      },
    },
  ]);
});

test("accepts base64 JSON and rejects malformed, missing, and oversized bodies", async () => {
  const encoded = buildHandler();
  const encodedEvent = eventFor(
    statusBody("CONFIRMED", "PENDING"),
  );
  encodedEvent.body = Buffer.from(encodedEvent.body, "utf8").toString(
    "base64",
  );
  encodedEvent.isBase64Encoded = true;
  assert.equal((await encoded.handler(encodedEvent)).statusCode, 200);
  assert.equal(encoded.calls.length, 1);

  const malformed = buildHandler();
  const malformedResponse = await malformed.handler(eventFor("{not-json"));
  assert.equal(malformedResponse.statusCode, 400);
  assert.equal(
    responseBody(malformedResponse).error.code,
    "INVALID_JSON",
  );
  assert.equal(malformed.calls.length, 0);

  const missing = buildHandler();
  const missingEvent = eventFor({});
  delete missingEvent.body;
  const missingResponse = await missing.handler(missingEvent);
  assert.equal(missingResponse.statusCode, 400);
  assert.equal(responseBody(missingResponse).error.code, "INVALID_JSON");
  assert.equal(missing.calls.length, 0);

  const oversized = buildHandler();
  const oversizedResponse = await oversized.handler(
    eventFor("x".repeat(MAX_BODY_BYTES + 1)),
  );
  assert.equal(oversizedResponse.statusCode, 413);
  assert.equal(
    responseBody(oversizedResponse).error.code,
    "PAYLOAD_TOO_LARGE",
  );
  assert.equal(oversized.calls.length, 0);
});

test("returns 404 when a conditional failure reveals no existing order", async () => {
  const calls = [];
  const documentClient = {
    async send(command) {
      calls.push({
        name: command.constructor.name,
        input: command.input,
      });
      if (command.constructor.name === "UpdateCommand") {
        throw conditionalFailure();
      }
      return {};
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(
    eventFor(statusBody("CONFIRMED", "PENDING")),
  );

  assert.equal(response.statusCode, 404);
  assert.equal(responseBody(response).error.code, "ORDER_NOT_FOUND");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].name, "GetCommand");
  assert.deepEqual(calls[1].input, {
    TableName: "orders-test",
    Key: { orderId: ORDER_ID },
    ConsistentRead: true,
  });
});

test("returns 409 for stale or invalid stored status", async () => {
  for (const currentStatus of ["CANCELLED", "UNKNOWN"]) {
    const calls = [];
    const documentClient = {
      async send(command) {
        calls.push(command);
        if (command.constructor.name === "UpdateCommand") {
          throw conditionalFailure();
        }
        return {
          Item: {
            orderId: ORDER_ID,
            entityType: "ORDER",
            status: currentStatus,
            updatedAt: UPDATED_AT,
          },
        };
      },
    };
    const { handler } = buildHandler({ documentClient });
    const response = await handler(
      eventFor(statusBody("CONFIRMED", "PENDING")),
    );

    assert.equal(response.statusCode, 409, currentStatus);
    assert.equal(
      responseBody(response).error.code,
      "ORDER_STATUS_CONFLICT",
      currentStatus,
    );
    assert.equal(calls.length, 2, currentStatus);
  }
});

test("treats an already-applied requested status as idempotent success", async () => {
  const calls = [];
  const documentClient = {
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "UpdateCommand") {
        throw conditionalFailure();
      }
      return {
        Item: {
          orderId: ORDER_ID,
          entityType: "ORDER",
          status: "CONFIRMED",
          updatedAt: "2026-07-23T18:29:00.000Z",
          pickupTime: PICKUP_TIME,
          restaurantNote: RESTAURANT_NOTE,
          statusUpdatedBy: "another-admin",
          customerId: "must-not-be-returned",
        },
      };
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(
    eventFor(
      statusBody("CONFIRMED", "PENDING", {
        restaurantNote: ` ${RESTAURANT_NOTE} `,
      }),
    ),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), {
    order: {
      orderId: ORDER_ID,
      status: "CONFIRMED",
      updatedAt: "2026-07-23T18:29:00.000Z",
      pickupTime: PICKUP_TIME,
      restaurantNote: RESTAURANT_NOTE,
    },
  });
  assert.ok(!response.body.includes("another-admin"));
  assert.ok(!response.body.includes("customerId"));
  assert.equal(calls.length, 2);
});

test("returns a conflict when same-status retry details do not match", async () => {
  const mismatchedOrders = [
    {
      pickupTime: "2026-07-23T20:00:00.000Z",
      restaurantNote: RESTAURANT_NOTE,
    },
    {
      pickupTime: PICKUP_TIME,
      restaurantNote: "A different customer message.",
    },
    {
      pickupTime: PICKUP_TIME,
    },
  ];

  for (const statusDetails of mismatchedOrders) {
    const calls = [];
    const documentClient = {
      async send(command) {
        calls.push(command);
        if (command.constructor.name === "UpdateCommand") {
          throw conditionalFailure();
        }
        return {
          Item: {
            orderId: ORDER_ID,
            entityType: "ORDER",
            status: "CONFIRMED",
            updatedAt: UPDATED_AT,
            ...statusDetails,
          },
        };
      },
    };
    const { handler } = buildHandler({ documentClient });
    const response = await handler(
      eventFor(
        statusBody("CONFIRMED", "PENDING", {
          restaurantNote: RESTAURANT_NOTE,
        }),
      ),
    );

    assert.equal(response.statusCode, 409, JSON.stringify(statusDetails));
    assert.equal(
      responseBody(response).error.code,
      "ORDER_STATUS_CONFLICT",
      JSON.stringify(statusDetails),
    );
    assert.equal(calls.length, 2, JSON.stringify(statusDetails));
  }
});

test("does not treat a non-order record as an existing order", async () => {
  const documentClient = {
    async send(command) {
      if (command.constructor.name === "UpdateCommand") {
        throw conditionalFailure();
      }
      return {
        Item: {
          orderId: ORDER_ID,
          entityType: "IDEMPOTENCY",
          status: "CONFIRMED",
          updatedAt: UPDATED_AT,
        },
      };
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(
    eventFor(statusBody("CONFIRMED", "PENDING")),
  );

  assert.equal(response.statusCode, 404);
  assert.equal(responseBody(response).error.code, "ORDER_NOT_FOUND");
});

test("returns a sanitized configuration error without calling DynamoDB", async () => {
  const { handler, calls } = buildHandler({ tableName: "" });
  const response = await handler(
    eventFor(statusBody("CONFIRMED", "PENDING")),
  );

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.equal(calls.length, 0);
});

test("returns sanitized errors for update, conflict-read, and response failures", async () => {
  const updateFailure = buildHandler({
    documentClient: {
      async send() {
        const error = new Error("secret update failure");
        error.name = "ProvisionedThroughputExceededException";
        throw error;
      },
    },
  });
  const updateResponse = await updateFailure.handler(
    eventFor(statusBody("CONFIRMED", "PENDING")),
  );
  assert.equal(updateResponse.statusCode, 500);
  assert.ok(!updateResponse.body.includes("secret update failure"));

  let conflictReadCalls = 0;
  const conflictReadFailure = buildHandler({
    documentClient: {
      async send() {
        conflictReadCalls += 1;
        if (conflictReadCalls === 1) {
          throw conditionalFailure();
        }
        const error = new Error("secret read failure");
        error.name = "InternalServerError";
        throw error;
      },
    },
  });
  const readResponse = await conflictReadFailure.handler(
    eventFor(statusBody("CONFIRMED", "PENDING")),
  );
  assert.equal(readResponse.statusCode, 500);
  assert.ok(!readResponse.body.includes("secret read failure"));

  const invalidResponse = buildHandler({
    documentClient: {
      async send() {
        return { Attributes: { orderId: ORDER_ID } };
      },
    },
  });
  const invalidResponseResult = await invalidResponse.handler(
    eventFor(statusBody("CONFIRMED", "PENDING")),
  );
  assert.equal(invalidResponseResult.statusCode, 500);
  assert.equal(
    responseBody(invalidResponseResult).error.code,
    "INTERNAL_ERROR",
  );
});
