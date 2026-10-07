"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  createListOrdersHandler,
  decodePaginationToken,
  encodePaginationToken,
} = require("../handler/list-orders");

const adminClaims = {
  sub: "admin-user-123",
  "cognito:groups": "customers,admin",
};
const paginationKey = {
  orderId: "ord_older",
  entityType: "ORDER",
  createdAt: "2026-07-20T19:00:00.000Z",
};
const storedOrder = {
  orderId: "ord_newest",
  entityType: "ORDER",
  eventType: "ORDER_CREATED",
  status: "CONFIRMED",
  notificationStatus: "SENT",
  fulfillment: "PICKUP",
  customerId: "customer-secret-sub",
  customerEmail: "customer@example.com",
  clientRequestId: "order-client-request",
  requestHash: "secret-request-hash",
  pickupContact: {
    name: "Sithu Lin",
    phoneNumber: "+14155552671",
  },
  items: [
    {
      dishId: "sora-roll",
      name: "Sora house roll",
      category: "Maki",
      quantity: 2,
      unitPriceCents: 2450,
      lineTotalCents: 4900,
    },
  ],
  itemCount: 2,
  currency: "USD",
  subtotalCents: 4900,
  totalCents: 4900,
  customerNote: "Chopsticks, please.",
  createdAt: "2026-07-22T20:15:00.000Z",
  updatedAt: "2026-07-22T20:15:00.000Z",
  pickupTime: "2026-07-22T21:00:00.000Z",
  restaurantNote: "Please come to the pickup counter.",
};
const idempotencyMarker = {
  orderId: "IDEMPOTENCY#customer#request",
  entityType: "IDEMPOTENCY",
  referencedOrderId: storedOrder.orderId,
  requestHash: "secret-request-hash",
};
const silentLogger = { error() {} };

const eventFor = (queryStringParameters, claims = adminClaims) => ({
  queryStringParameters,
  requestContext: { authorizer: { claims } },
});

const responseBody = (response) => JSON.parse(response.body);

const buildHandler = (overrides = {}) => {
  const calls = [];
  const result = overrides.result || {
    Items: [storedOrder, idempotencyMarker],
    LastEvaluatedKey: paginationKey,
  };
  const documentClient = overrides.documentClient || {
    async send(command) {
      calls.push(command);
      return structuredClone(result);
    },
  };

  return {
    calls,
    handler: createListOrdersHandler({
      documentClient,
      tableName: "orders-test",
      indexName: "entityType-createdAt-index",
      adminGroupName: "admin",
      allowedOrigin: "https://sushi.example",
      logger: silentLogger,
      ...overrides,
    }),
  };
};

test("queries the order GSI newest first with a bounded default limit", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(eventFor(null));
  const body = responseBody(response);

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    TableName: "orders-test",
    IndexName: "entityType-createdAt-index",
    KeyConditionExpression: "#entityType = :orderType",
    ExpressionAttributeNames: {
      "#entityType": "entityType",
    },
    ExpressionAttributeValues: {
      ":orderType": "ORDER",
    },
    ScanIndexForward: false,
    Limit: DEFAULT_LIMIT,
  });

  assert.equal(body.orders.length, 1);
  assert.deepEqual(body.orders[0], {
    orderId: storedOrder.orderId,
    status: storedOrder.status,
    notificationStatus: storedOrder.notificationStatus,
    fulfillment: storedOrder.fulfillment,
    pickupContact: storedOrder.pickupContact,
    items: storedOrder.items,
    itemCount: storedOrder.itemCount,
    currency: storedOrder.currency,
    subtotalCents: storedOrder.subtotalCents,
    totalCents: storedOrder.totalCents,
    customerNote: storedOrder.customerNote,
    createdAt: storedOrder.createdAt,
    updatedAt: storedOrder.updatedAt,
    pickupTime: storedOrder.pickupTime,
    restaurantNote: storedOrder.restaurantNote,
    customerEmail: storedOrder.customerEmail,
  });
  assert.ok(!Object.hasOwn(body.orders[0], "customerId"));
  assert.ok(!Object.hasOwn(body.orders[0], "requestHash"));
  assert.ok(!Object.hasOwn(body.orders[0], "entityType"));
  assert.deepEqual(decodePaginationToken(body.nextToken), paginationKey);
});

test("omits confirmation details from legacy orders that do not have them", async () => {
  const legacyOrder = structuredClone(storedOrder);
  delete legacyOrder.pickupTime;
  delete legacyOrder.restaurantNote;

  const { handler } = buildHandler({
    result: { Items: [legacyOrder] },
  });
  const response = await handler(eventFor(null));
  const [order] = responseBody(response).orders;

  assert.equal(response.statusCode, 200);
  assert.ok(!Object.hasOwn(order, "pickupTime"));
  assert.ok(!Object.hasOwn(order, "restaurantNote"));
});

test("returns failed-pickup details without internal tracking fields", async () => {
  const failedOrder = structuredClone(storedOrder);
  failedOrder.status = "FAILED_TO_PICKUP";
  delete failedOrder.pickupTime;
  failedOrder.scheduledPickupTime =
    "2026-07-22T21:00:00.000Z";
  failedOrder.failedToPickupAt =
    "2026-07-22T22:00:00.000Z";
  failedOrder.pickupFailureRecordKey =
    `FAILURE#${failedOrder.failedToPickupAt}#${failedOrder.orderId}`;
  failedOrder.statusUpdatedBy = "admin-secret-sub";

  const { handler } = buildHandler({
    result: { Items: [failedOrder] },
  });
  const response = await handler(eventFor(null));
  const [order] = responseBody(response).orders;

  assert.equal(response.statusCode, 200);
  assert.equal(
    order.scheduledPickupTime,
    failedOrder.scheduledPickupTime,
  );
  assert.equal(
    order.failedToPickupAt,
    failedOrder.failedToPickupAt,
  );
  assert.ok(!Object.hasOwn(order, "pickupTime"));
  assert.ok(!Object.hasOwn(order, "pickupFailureRecordKey"));
  assert.ok(!Object.hasOwn(order, "statusUpdatedBy"));
});

test("uses a caller limit and opaque pagination token as ExclusiveStartKey", async () => {
  const token = encodePaginationToken(paginationKey);
  const { handler, calls } = buildHandler({
    result: { Items: [], LastEvaluatedKey: undefined },
  });
  const response = await handler(
    eventFor({ limit: "10", nextToken: token }),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].input.Limit, 10);
  assert.deepEqual(calls[0].input.ExclusiveStartKey, paginationKey);
  assert.deepEqual(responseBody(response), { orders: [], nextToken: null });
});

test("requires Cognito authentication and the configured admin group", async () => {
  const { handler, calls } = buildHandler();

  const unauthenticated = await handler(eventFor(null, {}));
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(responseBody(unauthenticated).error.code, "UNAUTHORIZED");

  const customer = await handler(
    eventFor(null, {
      sub: "customer-user",
      "cognito:groups": "customers",
    }),
  );
  assert.equal(customer.statusCode, 403);
  assert.equal(responseBody(customer).error.code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("accepts HTTP API claims and common Cognito group formats", async () => {
  for (const groups of [
    ["customer", "admin"],
    "[\"customer\",\"admin\"]",
    "customer, admin",
  ]) {
    const { handler } = buildHandler({
      result: { Items: [] },
    });
    const event = eventFor(null);
    event.requestContext.authorizer = {
      jwt: {
        claims: {
          sub: "admin-user",
          "cognito:groups": groups,
        },
      },
    };

    const response = await handler(event);
    assert.equal(response.statusCode, 200, JSON.stringify(groups));
  }
});

test("rejects unknown, malformed, and out-of-range query parameters", async () => {
  const invalidQueries = [
    { status: "PENDING" },
    { limit: "0" },
    { limit: String(MAX_LIMIT + 1) },
    { limit: "1.5" },
    { limit: " 10 " },
    { nextToken: "not+a+base64url+token" },
    {
      nextToken: Buffer.from(
        JSON.stringify({
          orderId: "IDEMPOTENCY#secret",
          entityType: "IDEMPOTENCY",
          createdAt: "2026-07-20T19:00:00.000Z",
        }),
      ).toString("base64url"),
    },
  ];

  for (const query of invalidQueries) {
    const { handler, calls } = buildHandler();
    const response = await handler(eventFor(query));

    assert.equal(response.statusCode, 400, JSON.stringify(query));
    assert.equal(responseBody(response).error.code, "INVALID_QUERY");
    assert.equal(calls.length, 0);
  }
});

test("never returns idempotency markers even if a malformed index response contains one", async () => {
  const { handler } = buildHandler({
    result: {
      Items: [
        idempotencyMarker,
        { orderId: "missing-type" },
        storedOrder,
      ],
    },
  });
  const response = await handler(eventFor({ limit: "100" }));
  const body = responseBody(response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    body.orders.map(({ orderId }) => orderId),
    [storedOrder.orderId],
  );
});

test("returns sanitized errors for missing configuration and DynamoDB failures", async () => {
  const missingConfig = buildHandler({ indexName: "" });
  const missingConfigResponse = await missingConfig.handler(eventFor(null));
  assert.equal(missingConfigResponse.statusCode, 500);
  assert.equal(missingConfig.calls.length, 0);

  const documentClient = {
    async send() {
      const error = new Error("secret DynamoDB details");
      error.name = "InternalServerError";
      throw error;
    },
  };
  const failing = buildHandler({ documentClient });
  const response = await failing.handler(eventFor(null));

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.ok(!response.body.includes("secret DynamoDB details"));
});
