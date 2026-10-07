"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  createGetCustomerPickupFailuresHandler,
  decodePaginationToken,
  encodePaginationToken,
} = require("../handler/get-customer-pickup-failures");

const ORDER_ID = "ord_550e8400-e29b-41d4-a716-446655440001";
const OLDER_ORDER_ID =
  "ord_550e8400-e29b-41d4-a716-446655440002";
const CUSTOMER_ID = "customer-user-123";
const FAILED_PICKUP_AT = "2026-07-23T20:30:00.000Z";
const OLDER_FAILED_PICKUP_AT = "2026-07-20T20:30:00.000Z";
const SCHEDULED_PICKUP_TIME = "2026-07-23T19:30:00.000Z";
const OLDER_SCHEDULED_PICKUP_TIME =
  "2026-07-20T19:30:00.000Z";
const failureRecordKey =
  `FAILURE#${FAILED_PICKUP_AT}#${ORDER_ID}`;
const olderFailureRecordKey =
  `FAILURE#${OLDER_FAILED_PICKUP_AT}#${OLDER_ORDER_ID}`;
const adminClaims = {
  sub: "admin-user-123",
  "cognito:groups": "customers,admin",
};
const storedOrder = {
  orderId: ORDER_ID,
  entityType: "ORDER",
  customerId: CUSTOMER_ID,
  status: "FAILED_TO_PICKUP",
};
const summaryRecord = {
  customerId: CUSTOMER_ID,
  recordKey: "SUMMARY",
  recordType: "SUMMARY",
  failedPickupCount: 2,
  lastFailedOrderId: ORDER_ID,
  lastFailedPickupAt: FAILED_PICKUP_AT,
};
const failureRecord = {
  customerId: CUSTOMER_ID,
  recordKey: failureRecordKey,
  recordType: "FAILURE",
  orderId: ORDER_ID,
  scheduledPickupTime: SCHEDULED_PICKUP_TIME,
  failedPickupAt: FAILED_PICKUP_AT,
  createdAt: FAILED_PICKUP_AT,
};
const olderFailureRecord = {
  customerId: CUSTOMER_ID,
  recordKey: olderFailureRecordKey,
  recordType: "FAILURE",
  orderId: OLDER_ORDER_ID,
  scheduledPickupTime: OLDER_SCHEDULED_PICKUP_TIME,
  failedPickupAt: OLDER_FAILED_PICKUP_AT,
  createdAt: OLDER_FAILED_PICKUP_AT,
};
const silentLogger = { error() {} };

const eventFor = (
  queryStringParameters = null,
  claims = adminClaims,
  orderId = ORDER_ID,
) => ({
  pathParameters: { orderId },
  queryStringParameters,
  requestContext: { authorizer: { claims } },
});

const responseBody = (response) => JSON.parse(response.body);

const buildHandler = (overrides = {}) => {
  const calls = [];
  const order = Object.hasOwn(overrides, "order")
    ? overrides.order
    : storedOrder;
  const summary = Object.hasOwn(overrides, "summary")
    ? overrides.summary
    : summaryRecord;
  const failures = Object.hasOwn(overrides, "failures")
    ? overrides.failures
    : [failureRecord, olderFailureRecord];
  const lastEvaluatedKey = overrides.lastEvaluatedKey;
  const documentClient = overrides.documentClient || {
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "QueryCommand") {
        return {
          Items: structuredClone(failures),
          ...(lastEvaluatedKey
            ? {
                LastEvaluatedKey:
                  structuredClone(lastEvaluatedKey),
              }
            : {}),
        };
      }

      if (command.input.Key?.recordKey === "SUMMARY") {
        return summary
          ? { Item: structuredClone(summary) }
          : {};
      }

      return order ? { Item: structuredClone(order) } : {};
    },
  };

  return {
    calls,
    handler: createGetCustomerPickupFailuresHandler({
      documentClient,
      ordersTableName: "orders-test",
      pickupFailuresTableName: "pickup-failures-test",
      adminGroupName: "admin",
      allowedOrigin: "https://sushi.example",
      logger: silentLogger,
      ...overrides,
    }),
  };
};

test("loads a customer's summary and failed orders through an order ID", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(eventFor());

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(responseBody(response), {
    failedPickupCount: 2,
    lastFailedPickupAt: FAILED_PICKUP_AT,
    lastFailedOrderId: ORDER_ID,
    failures: [
      {
        orderId: ORDER_ID,
        scheduledPickupTime: SCHEDULED_PICKUP_TIME,
        failedPickupAt: FAILED_PICKUP_AT,
      },
      {
        orderId: OLDER_ORDER_ID,
        scheduledPickupTime: OLDER_SCHEDULED_PICKUP_TIME,
        failedPickupAt: OLDER_FAILED_PICKUP_AT,
      },
    ],
    nextToken: null,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].input, {
    TableName: "orders-test",
    Key: { orderId: ORDER_ID },
    ConsistentRead: true,
  });
  assert.deepEqual(calls[1].input, {
    TableName: "pickup-failures-test",
    KeyConditionExpression:
      "#customerId = :customerId AND " +
      "begins_with(#recordKey, :failurePrefix)",
    ExpressionAttributeNames: {
      "#customerId": "customerId",
      "#recordKey": "recordKey",
    },
    ExpressionAttributeValues: {
      ":customerId": CUSTOMER_ID,
      ":failurePrefix": "FAILURE#",
    },
    ScanIndexForward: false,
    ConsistentRead: true,
    Limit: DEFAULT_LIMIT,
  });
  assert.deepEqual(calls[2].input, {
    TableName: "pickup-failures-test",
    Key: {
      customerId: CUSTOMER_ID,
      recordKey: "SUMMARY",
    },
    ConsistentRead: true,
  });
  assert.ok(!response.body.includes(CUSTOMER_ID));
  assert.ok(!response.body.includes("recordKey"));
  assert.ok(!response.body.includes("recordType"));
});

test("returns an empty history when the customer has no failures", async () => {
  const { handler } = buildHandler({
    summary: undefined,
    failures: [],
  });
  const response = await handler(eventFor());

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), {
    failedPickupCount: 0,
    failures: [],
    nextToken: null,
  });
});

test("uses a bounded limit and customer-scoped opaque pagination token", async () => {
  const token = encodePaginationToken(olderFailureRecordKey);
  const nextKey = {
    customerId: CUSTOMER_ID,
    recordKey: failureRecordKey,
  };
  const { handler, calls } = buildHandler({
    lastEvaluatedKey: nextKey,
  });
  const response = await handler(
    eventFor({ limit: "7", nextToken: token }),
  );
  const queryInput = calls[1].input;

  assert.equal(response.statusCode, 200);
  assert.equal(queryInput.Limit, 7);
  assert.deepEqual(queryInput.ExclusiveStartKey, {
    customerId: CUSTOMER_ID,
    recordKey: olderFailureRecordKey,
  });
  assert.equal(
    decodePaginationToken(responseBody(response).nextToken),
    failureRecordKey,
  );
  assert.ok(
    !Buffer.from(
      responseBody(response).nextToken,
      "base64url",
    )
      .toString("utf8")
      .includes(CUSTOMER_ID),
  );
});

test("finishes a strong failure query before strongly reading the summary", async () => {
  const calls = [];
  let releaseFailures;
  let signalQueryStarted;
  const queryStarted = new Promise((resolve) => {
    signalQueryStarted = resolve;
  });
  const documentClient = {
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "QueryCommand") {
        signalQueryStarted();
        return new Promise((resolve) => {
          releaseFailures = resolve;
        });
      }

      if (command.input.Key?.recordKey === "SUMMARY") {
        return { Item: structuredClone(summaryRecord) };
      }

      return { Item: structuredClone(storedOrder) };
    },
  };
  const { handler } = buildHandler({ documentClient });
  const responsePromise = handler(eventFor());

  await queryStarted;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].constructor.name, "GetCommand");
  assert.equal(calls[0].input.ConsistentRead, true);
  assert.equal(calls[1].constructor.name, "QueryCommand");
  assert.equal(calls[1].input.ConsistentRead, true);

  releaseFailures({
    Items: structuredClone([failureRecord, olderFailureRecord]),
  });
  const response = await responsePromise;

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].constructor.name, "GetCommand");
  assert.equal(calls[2].input.Key.recordKey, "SUMMARY");
  assert.equal(calls[2].input.ConsistentRead, true);
});

test("requires Cognito admin membership before reading any table", async () => {
  const { handler, calls } = buildHandler();

  const unauthenticated = await handler(eventFor(null, {}));
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(responseBody(unauthenticated).error.code, "UNAUTHORIZED");

  const customer = await handler(
    eventFor(null, {
      sub: CUSTOMER_ID,
      "cognito:groups": "customers",
    }),
  );
  assert.equal(customer.statusCode, 403);
  assert.equal(responseBody(customer).error.code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("supports HTTP API claims and common admin-group formats", async () => {
  for (const groups of [
    ["customers", "admin"],
    "[\"customers\",\"admin\"]",
    "customers, admin",
  ]) {
    const { handler } = buildHandler();
    const event = eventFor();
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

test("rejects invalid order IDs and query parameters before DynamoDB", async () => {
  const invalidOrderIds = [
    undefined,
    "",
    "550e8400-e29b-41d4-a716-446655440001",
    "ord_not-a-uuid",
    " ord_550e8400-e29b-41d4-a716-446655440001 ",
  ];

  for (const orderId of invalidOrderIds) {
    const { handler, calls } = buildHandler();
    const event = eventFor(null, adminClaims, orderId);
    if (orderId === undefined) {
      event.pathParameters = {};
    }
    const response = await handler(event);

    assert.equal(response.statusCode, 400, String(orderId));
    assert.equal(
      responseBody(response).error.code,
      "INVALID_ORDER_ID",
    );
    assert.equal(calls.length, 0);
  }

  const invalidQueries = [
    { limit: "0" },
    { limit: String(MAX_LIMIT + 1) },
    { limit: "1.5" },
    { nextToken: "not-a-token" },
    {
      nextToken: Buffer.from(
        JSON.stringify({
          customerId: "forged-customer",
          recordKey: failureRecordKey,
        }),
        "utf8",
      ).toString("base64url"),
    },
    { unexpected: "value" },
  ];

  for (const query of invalidQueries) {
    const { handler, calls } = buildHandler();
    const response = await handler(eventFor(query));

    assert.equal(response.statusCode, 400, JSON.stringify(query));
    assert.equal(responseBody(response).error.code, "INVALID_QUERY");
    assert.equal(calls.length, 0);
  }
});

test("does not use a forged customer ID and hides missing or invalid orders", async () => {
  for (const order of [
    undefined,
    {
      orderId: ORDER_ID,
      entityType: "IDEMPOTENCY",
      customerId: CUSTOMER_ID,
    },
    {
      orderId: ORDER_ID,
      entityType: "ORDER",
      customerId: "",
    },
  ]) {
    const { handler, calls } = buildHandler({ order });
    const response = await handler(eventFor());

    assert.equal(response.statusCode, 404);
    assert.equal(responseBody(response).error.code, "ORDER_NOT_FOUND");
    assert.equal(calls.length, 1);
  }
});

test("returns sanitized configuration, storage, and malformed-record errors", async () => {
  const missingConfig = buildHandler({
    pickupFailuresTableName: "",
  });
  const configResponse = await missingConfig.handler(eventFor());
  assert.equal(configResponse.statusCode, 500);
  assert.equal(
    responseBody(configResponse).error.code,
    "INTERNAL_ERROR",
  );
  assert.equal(missingConfig.calls.length, 0);

  const storageFailure = buildHandler({
    documentClient: {
      async send() {
        const error = new Error("secret database details");
        error.name = "InternalServerError";
        throw error;
      },
    },
  });
  const storageResponse = await storageFailure.handler(eventFor());
  assert.equal(storageResponse.statusCode, 500);
  assert.ok(!storageResponse.body.includes("secret database details"));

  const invalidRecords = [
    {
      summary: {
        ...summaryRecord,
        failedPickupCount: "2",
      },
    },
    {
      failures: [
        {
          ...failureRecord,
          customerId: "another-customer",
        },
      ],
    },
    {
      lastEvaluatedKey: {
        customerId: "another-customer",
        recordKey: failureRecordKey,
      },
    },
  ];

  for (const overrides of invalidRecords) {
    const { handler } = buildHandler(overrides);
    const response = await handler(eventFor());
    assert.equal(response.statusCode, 500, JSON.stringify(overrides));
    assert.equal(
      responseBody(response).error.code,
      "INTERNAL_ERROR",
    );
  }
});
