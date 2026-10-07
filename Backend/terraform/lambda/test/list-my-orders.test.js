"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  createListMyOrdersHandler,
  decodePaginationToken,
  encodePaginationToken,
} = require("../handler/list-my-orders");

const customerClaims = {
  sub: "customer-user-123",
  email: "customer@example.com",
};
const customerOrderKey = `CUSTOMER#${customerClaims.sub}`;
const paginationKey = {
  orderId: "ord_older",
  customerOrderKey,
  createdAt: "2026-07-20T19:00:00.000Z",
};
const storedOrder = {
  orderId: "ord_newest",
  entityType: "ORDER",
  eventType: "ORDER_CREATED",
  status: "CONFIRMED",
  notificationStatus: "SENT",
  fulfillment: "PICKUP",
  customerId: customerClaims.sub,
  customerOrderKey,
  customerEmail: customerClaims.email,
  clientRequestId: "order-client-request",
  requestHash: "secret-request-hash",
  pickupContact: {
    name: "Sithu Lin",
    phoneNumber: "+14155552671",
    internalContactFlag: "do-not-return",
  },
  items: [
    {
      dishId: "sora-roll",
      name: "Sora house roll",
      category: "Maki",
      quantity: 2,
      unitPriceCents: 2450,
      lineTotalCents: 4900,
      internalVectorId: "do-not-return",
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
  menuVersion: 7,
};
const silentLogger = { error() {} };

const eventFor = (queryStringParameters, claims = customerClaims) => ({
  queryStringParameters,
  requestContext: { authorizer: { claims } },
});

const responseBody = (response) => JSON.parse(response.body);

const buildHandler = (overrides = {}) => {
  const calls = [];
  const result = overrides.result || {
    Items: [storedOrder],
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
    handler: createListMyOrdersHandler({
      documentClient,
      tableName: "orders-test",
      indexName: "customerOrderKey-createdAt-index",
      allowedOrigin: "https://sushi.example",
      logger: silentLogger,
      ...overrides,
    }),
  };
};

test("queries only the authenticated customer's order GSI newest first", async () => {
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
    IndexName: "customerOrderKey-createdAt-index",
    KeyConditionExpression: "#customerOrderKey = :customerOrderKey",
    ExpressionAttributeNames: {
      "#customerOrderKey": "customerOrderKey",
    },
    ExpressionAttributeValues: {
      ":customerOrderKey": customerOrderKey,
    },
    ScanIndexForward: false,
    Limit: DEFAULT_LIMIT,
  });

  assert.deepEqual(body.orders, [
    {
      orderId: storedOrder.orderId,
      status: storedOrder.status,
      fulfillment: storedOrder.fulfillment,
      pickupContact: {
        name: storedOrder.pickupContact.name,
        phoneNumber: storedOrder.pickupContact.phoneNumber,
      },
      items: [
        {
          dishId: storedOrder.items[0].dishId,
          name: storedOrder.items[0].name,
          category: storedOrder.items[0].category,
          quantity: storedOrder.items[0].quantity,
          unitPriceCents: storedOrder.items[0].unitPriceCents,
          lineTotalCents: storedOrder.items[0].lineTotalCents,
        },
      ],
      itemCount: storedOrder.itemCount,
      currency: storedOrder.currency,
      subtotalCents: storedOrder.subtotalCents,
      totalCents: storedOrder.totalCents,
      customerNote: storedOrder.customerNote,
      createdAt: storedOrder.createdAt,
      updatedAt: storedOrder.updatedAt,
      pickupTime: storedOrder.pickupTime,
      restaurantNote: storedOrder.restaurantNote,
    },
  ]);

  for (const field of [
    "customerId",
    "customerOrderKey",
    "customerEmail",
    "notificationStatus",
    "clientRequestId",
    "requestHash",
    "entityType",
    "eventType",
    "menuVersion",
  ]) {
    assert.ok(!Object.hasOwn(body.orders[0], field), field);
  }
  assert.ok(
    !Object.hasOwn(body.orders[0].pickupContact, "internalContactFlag"),
  );
  assert.ok(!Object.hasOwn(body.orders[0].items[0], "internalVectorId"));
  assert.deepEqual(
    decodePaginationToken(body.nextToken, customerOrderKey),
    paginationKey,
  );
});

test("omits confirmation details from legacy customer orders", async () => {
  const legacyOrder = structuredClone(storedOrder);
  delete legacyOrder.pickupTime;
  delete legacyOrder.restaurantNote;

  const { handler } = buildHandler({
    result: {
      Items: [legacyOrder],
      LastEvaluatedKey: undefined,
    },
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
    result: {
      Items: [failedOrder],
      LastEvaluatedKey: undefined,
    },
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

test("uses a caller limit and own opaque token as ExclusiveStartKey", async () => {
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

test("rejects a pagination token belonging to another customer", async () => {
  const otherCustomerToken = encodePaginationToken({
    ...paginationKey,
    customerOrderKey: "CUSTOMER#someone-else",
  });
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({ nextToken: otherCustomerToken }),
  );

  assert.equal(response.statusCode, 400);
  assert.equal(responseBody(response).error.code, "INVALID_QUERY");
  assert.equal(calls.length, 0);
});

test("requires Cognito authentication and supports HTTP API JWT claims", async () => {
  const unauthenticated = buildHandler();
  const unauthorizedResponse = await unauthenticated.handler(
    eventFor(null, {}),
  );

  assert.equal(unauthorizedResponse.statusCode, 401);
  assert.equal(
    responseBody(unauthorizedResponse).error.code,
    "UNAUTHORIZED",
  );
  assert.equal(unauthenticated.calls.length, 0);

  const authenticated = buildHandler({
    result: { Items: [], LastEvaluatedKey: undefined },
  });
  const event = eventFor(null);
  event.requestContext.authorizer = {
    jwt: { claims: customerClaims },
  };
  const response = await authenticated.handler(event);

  assert.equal(response.statusCode, 200);
  assert.equal(
    authenticated.calls[0].input.ExpressionAttributeValues[
      ":customerOrderKey"
    ],
    customerOrderKey,
  );
});

test("filters malformed, non-order, and cross-customer index results", async () => {
  const { handler } = buildHandler({
    result: {
      Items: [
        {
          ...storedOrder,
          orderId: "IDEMPOTENCY#customer#request",
          entityType: "IDEMPOTENCY",
        },
        {
          ...storedOrder,
          orderId: "ord_wrong_customer_id",
          customerId: "someone-else",
        },
        {
          ...storedOrder,
          orderId: "ord_wrong_customer_key",
          customerOrderKey: "CUSTOMER#someone-else",
        },
        { orderId: "ord_malformed" },
        storedOrder,
      ],
      LastEvaluatedKey: undefined,
    },
  });
  const response = await handler(eventFor(null));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    responseBody(response).orders.map(({ orderId }) => orderId),
    [storedOrder.orderId],
  );
});

test("rejects unknown, malformed, and out-of-range query parameters", async () => {
  const invalidQueries = [
    { customerId: "someone-else" },
    { status: "PENDING" },
    { limit: "0" },
    { limit: String(MAX_LIMIT + 1) },
    { limit: "1.5" },
    { limit: " 10 " },
    { nextToken: "not+a+base64url+token" },
    {
      nextToken: encodePaginationToken({
        ...paginationKey,
        entityType: "ORDER",
      }),
    },
    {
      nextToken: encodePaginationToken({
        orderId: paginationKey.orderId,
        customerOrderKey,
      }),
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

test("returns sanitized errors for configuration and DynamoDB failures", async () => {
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
  const failingResponse = await failing.handler(eventFor(null));

  assert.equal(failingResponse.statusCode, 500);
  assert.equal(
    responseBody(failingResponse).error.code,
    "INTERNAL_ERROR",
  );
  assert.ok(!failingResponse.body.includes("secret DynamoDB details"));
});

test("fails closed rather than emitting an invalid DynamoDB page key", async () => {
  const { handler } = buildHandler({
    result: {
      Items: [storedOrder],
      LastEvaluatedKey: {
        ...paginationKey,
        customerOrderKey: "CUSTOMER#someone-else",
      },
    },
  });
  const response = await handler(eventFor(null));

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.ok(!response.body.includes("someone-else"));
});
