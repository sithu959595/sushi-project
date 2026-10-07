"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createOrderHandler,
  DEFAULT_PAUSED_MESSAGE,
  IDEMPOTENCY_ENTITY_TYPE,
  MENU_RECORD_ID,
  ORDER_ENTITY_TYPE,
  ORDERING_CONFIG_ENTITY_TYPE,
  ORDERING_CONFIG_ID,
} = require("../handler/create-order");

const liveMenu = {
  id: MENU_RECORD_ID,
  version: 1721682000000,
  items: [
    {
      id: "sora-roll",
      category: "Maki",
      name: "Sora house roll",
      description: "Snow crab, avocado, cucumber, tuna, toasted sesame.",
      price: "24.50",
      availability: "available",
    },
    {
      id: "akami",
      category: "Nigiri",
      name: "Bluefin akami",
      description: "Lean bluefin tuna.",
      price: "14",
      availability: "available",
    },
    {
      id: "uni",
      category: "Nigiri",
      name: "Santa Barbara uni",
      description: "Local sea urchin.",
      price: "18",
      availability: "out",
    },
  ],
};

const frontendOrder = {
  clientRequestId: "order-550e8400-e29b-41d4-a716-446655440000",
  items: [
    { dishId: "sora-roll", quantity: 2 },
    { dishId: "akami", quantity: 1 },
  ],
  fulfillment: "pickup",
  pickupContact: {
    name: "Sithu Lin",
    phoneNumber: "+14155552671",
  },
  customerNote: "Please include chopsticks.",
};

const defaultClaims = {
  sub: "8a18f36d-9730-4c63-8b8a-7f5e6ee1472a",
  email: "customer@example.com",
};
const silentLogger = { error() {} };

const eventFor = (body, claims = defaultClaims) => ({
  body: typeof body === "string" ? body : JSON.stringify(body),
  requestContext: { authorizer: { claims } },
});

const responseBody = (response) => JSON.parse(response.body);

const buildHandler = (overrides = {}) => {
  const calls = [];
  const records = overrides.records || new Map();
  const menuRecord = Object.hasOwn(overrides, "menuRecord")
    ? overrides.menuRecord
    : liveMenu;
  const documentClient = overrides.documentClient || {
    async send(command) {
      calls.push(command);
      const input = command.input;

      if (input.TransactItems) {
        const condition = input.TransactItems[0].ConditionCheck;
        const orderingConfiguration = records.get(
          condition.Key.orderId,
        );
        if (
          orderingConfiguration &&
          (orderingConfiguration.entityType !==
            ORDERING_CONFIG_ENTITY_TYPE ||
            orderingConfiguration.acceptingOrders !== true)
        ) {
          const error = new Error("ordering is paused");
          error.name = "TransactionCanceledException";
          error.CancellationReasons = [
            {
              Code: "ConditionalCheckFailed",
              Item: structuredClone(orderingConfiguration),
            },
            { Code: "None" },
            { Code: "None" },
          ];
          throw error;
        }

        for (const transactionItem of input.TransactItems) {
          if (!transactionItem.Put) {
            continue;
          }
          const item = transactionItem.Put.Item;
          if (records.has(item.orderId)) {
            const error = new Error("conditional transaction failed");
            error.name = "TransactionCanceledException";
            throw error;
          }
        }

        input.TransactItems
          .filter(({ Put }) => Put)
          .forEach(({ Put }) => {
            records.set(Put.Item.orderId, structuredClone(Put.Item));
          });
        return {};
      }

      if (input.Key?.id === MENU_RECORD_ID) {
        return menuRecord ? { Item: structuredClone(menuRecord) } : {};
      }

      if (input.Key?.orderId) {
        const item = records.get(input.Key.orderId);
        return item ? { Item: structuredClone(item) } : {};
      }

      throw new Error("Unexpected test command");
    },
  };

  return {
    calls,
    records,
    handler: createOrderHandler({
      documentClient,
      dishesTableName: "dishes-test",
      ordersTableName: "orders-test",
      allowedOrigin: "https://sushi.example",
      now: () => new Date("2026-07-22T20:15:00.000Z"),
      randomUUID: () => "550e8400-e29b-41d4-a716-446655440001",
      logger: silentLogger,
      ...overrides,
    }),
  };
};

test("creates an authoritative pending pickup order and idempotency marker", async () => {
  const { handler, calls, records } = buildHandler();
  const response = await handler(eventFor(frontendOrder));
  const body = responseBody(response);

  assert.equal(response.statusCode, 201);
  assert.equal(
    response.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(body, {
    orderId: "ord_550e8400-e29b-41d4-a716-446655440001",
    status: "PENDING",
    notificationStatus: "PENDING",
    fulfillment: "pickup",
    currency: "USD",
    itemCount: 3,
    subtotalCents: 6300,
    totalCents: 6300,
    createdAt: "2026-07-22T20:15:00.000Z",
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].input.TableName, "orders-test");
  assert.equal(calls[0].input.ConsistentRead, true);
  assert.deepEqual(calls[1].input, {
    TableName: "dishes-test",
    Key: { id: MENU_RECORD_ID },
    ConsistentRead: true,
  });

  const transaction = calls[2].input.TransactItems;
  assert.equal(transaction.length, 3);
  assert.deepEqual(transaction[0].ConditionCheck, {
    TableName: "orders-test",
    Key: { orderId: ORDERING_CONFIG_ID },
    ConditionExpression:
      "attribute_not_exists(#orderId) OR " +
      "(#entityType = :configType AND #acceptingOrders = :enabled)",
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
  });
  const order = transaction[1].Put.Item;
  const marker = transaction[2].Put.Item;

  assert.equal(order.entityType, ORDER_ENTITY_TYPE);
  assert.equal(order.eventType, "ORDER_CREATED");
  assert.equal(order.status, "PENDING");
  assert.equal(order.notificationStatus, "PENDING");
  assert.equal(order.customerId, defaultClaims.sub);
  assert.equal(
    order.customerOrderKey,
    `CUSTOMER#${defaultClaims.sub}`,
  );
  assert.equal(order.customerEmail, defaultClaims.email);
  assert.equal(order.fulfillment, "PICKUP");
  assert.equal(order.menuVersion, liveMenu.version);
  assert.deepEqual(order.pickupContact, frontendOrder.pickupContact);
  assert.equal(order.customerNote, frontendOrder.customerNote);
  assert.deepEqual(order.items, [
    {
      dishId: "sora-roll",
      name: "Sora house roll",
      category: "Maki",
      quantity: 2,
      unitPriceCents: 2450,
      lineTotalCents: 4900,
    },
    {
      dishId: "akami",
      name: "Bluefin akami",
      category: "Nigiri",
      quantity: 1,
      unitPriceCents: 1400,
      lineTotalCents: 1400,
    },
  ]);
  assert.equal(marker.entityType, IDEMPOTENCY_ENTITY_TYPE);
  assert.equal(
    marker.orderId,
    `IDEMPOTENCY#${defaultClaims.sub}#${frontendOrder.clientRequestId}`,
  );
  assert.equal(marker.referencedOrderId, order.orderId);
  assert.equal(marker.requestHash, order.requestHash);
  assert.ok(!Object.hasOwn(marker, "customerOrderKey"));
  assert.equal(records.size, 2);
});

test("never accepts prices, customer identity, or other unknown client fields", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({
      ...frontendOrder,
      customerId: "forged-user",
      items: [
        {
          dishId: "sora-roll",
          quantity: 2,
          unitPriceCents: 1,
        },
      ],
    }),
  );

  assert.equal(response.statusCode, 422);
  const fields = responseBody(response).error.details.map(({ field }) => field);
  assert.ok(fields.includes("customerId"));
  assert.ok(fields.includes("items[0].unitPriceCents"));
  assert.equal(calls.length, 0);
});

test("requires Cognito authentication and supports HTTP API JWT claims", async () => {
  const unauthenticated = buildHandler();
  const unauthorizedResponse = await unauthenticated.handler(
    eventFor(frontendOrder, {}),
  );

  assert.equal(unauthorizedResponse.statusCode, 401);
  assert.equal(responseBody(unauthorizedResponse).error.code, "UNAUTHORIZED");
  assert.equal(unauthenticated.calls.length, 0);

  const authenticated = buildHandler();
  const event = eventFor(frontendOrder);
  event.requestContext.authorizer = {
    jwt: { claims: defaultClaims },
  };
  const response = await authenticated.handler(event);

  assert.equal(response.statusCode, 201);
  const order = authenticated.calls[2].input.TransactItems[1].Put.Item;
  assert.equal(order.customerId, defaultClaims.sub);
  assert.equal(order.customerEmail, defaultClaims.email);
});

test("accepts base64 JSON and rejects malformed, missing, and oversized bodies", async () => {
  const encoded = buildHandler();
  const base64Event = eventFor(frontendOrder);
  base64Event.body = Buffer.from(base64Event.body, "utf8").toString("base64");
  base64Event.isBase64Encoded = true;
  assert.equal((await encoded.handler(base64Event)).statusCode, 201);

  const invalid = buildHandler();
  const malformed = await invalid.handler(eventFor("{not-json"));
  const missing = await invalid.handler({
    requestContext: { authorizer: { claims: defaultClaims } },
  });
  const oversized = await invalid.handler(
    eventFor("x".repeat(64 * 1024 + 1)),
  );

  assert.equal(malformed.statusCode, 400);
  assert.equal(responseBody(malformed).error.code, "INVALID_JSON");
  assert.equal(missing.statusCode, 400);
  assert.equal(oversized.statusCode, 413);
  assert.equal(invalid.calls.length, 0);
});

test("rejects missing and out dishes before writing an order", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({
      ...frontendOrder,
      items: [
        { dishId: "missing-dish", quantity: 1 },
        { dishId: "uni", quantity: 1 },
      ],
    }),
  );
  const body = responseBody(response);

  assert.equal(response.statusCode, 409);
  assert.equal(body.error.code, "MENU_CHANGED");
  assert.deepEqual(
    body.error.details.map(({ dishId, reason }) => ({ dishId, reason })),
    [
      { dishId: "missing-dish", reason: "NOT_FOUND" },
      { dishId: "uni", reason: "OUT" },
    ],
  );
  assert.equal(calls.length, 2);
  assert.ok(!calls.some(({ input }) => input.TransactItems));
});

test("fails closed when the aggregate live menu is unavailable or invalid", async () => {
  const unavailable = buildHandler({ menuRecord: null });
  const unavailableResponse = await unavailable.handler(eventFor(frontendOrder));
  assert.equal(unavailableResponse.statusCode, 503);
  assert.equal(
    responseBody(unavailableResponse).error.code,
    "MENU_UNAVAILABLE",
  );

  const invalid = buildHandler({
    menuRecord: { id: MENU_RECORD_ID, items: [{ id: "broken" }] },
  });
  const invalidResponse = await invalid.handler(eventFor(frontendOrder));
  assert.equal(invalidResponse.statusCode, 500);
  assert.equal(responseBody(invalidResponse).error.code, "INTERNAL_ERROR");
  assert.ok(!invalidResponse.body.includes("Invalid stored menu"));
});

test("returns the original order for an exact idempotent replay", async () => {
  const { handler, calls, records } = buildHandler();
  const first = await handler(eventFor(frontendOrder));
  const firstCallCount = calls.length;
  const second = await handler(eventFor(frontendOrder));
  const body = responseBody(second);

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(body.orderId, responseBody(first).orderId);
  assert.equal(body.idempotentReplay, true);
  assert.equal(records.size, 2);
  assert.equal(calls.length, firstCallCount + 2);
  assert.ok(
    calls
      .slice(firstCallCount)
      .every(({ input }) => input.TableName === "orders-test"),
  );
});

test("rejects reuse of a client request ID with a different body", async () => {
  const { handler, calls, records } = buildHandler();
  assert.equal((await handler(eventFor(frontendOrder))).statusCode, 201);
  const firstCallCount = calls.length;

  const response = await handler(
    eventFor({
      ...frontendOrder,
      items: [{ dishId: "akami", quantity: 1 }],
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.equal(
    responseBody(response).error.code,
    "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(records.size, 2);
  assert.equal(calls.length, firstCallCount + 1);
});

test("atomically rejects a new order while ordering is paused", async () => {
  const pauseMessage = "The kitchen is catching up. Please try again soon.";
  const records = new Map([
    [
      ORDERING_CONFIG_ID,
      {
        orderId: ORDERING_CONFIG_ID,
        entityType: ORDERING_CONFIG_ENTITY_TYPE,
        acceptingOrders: false,
        message: pauseMessage,
      },
    ],
  ]);
  const { handler, calls } = buildHandler({ records });

  const response = await handler(eventFor(frontendOrder));

  assert.equal(response.statusCode, 503);
  assert.deepEqual(responseBody(response), {
    error: {
      code: "ORDERING_PAUSED",
      message: pauseMessage,
    },
  });
  assert.equal(records.size, 1);
  assert.ok(![...records.values()].some(({ entityType }) =>
    [ORDER_ENTITY_TYPE, IDEMPOTENCY_ENTITY_TYPE].includes(entityType),
  ));
  assert.ok(calls.some(({ input }) => input.TransactItems));
});

test("creates a new order when the stored ordering configuration is enabled", async () => {
  const orderingConfiguration = {
    orderId: ORDERING_CONFIG_ID,
    entityType: ORDERING_CONFIG_ENTITY_TYPE,
    acceptingOrders: true,
    message: "",
  };
  const records = new Map([
    [ORDERING_CONFIG_ID, structuredClone(orderingConfiguration)],
  ]);
  const { handler } = buildHandler({ records });

  const response = await handler(eventFor(frontendOrder));

  assert.equal(response.statusCode, 201);
  assert.deepEqual(records.get(ORDERING_CONFIG_ID), orderingConfiguration);
  assert.equal(records.size, 3);
  assert.equal(
    [...records.values()].filter(
      ({ entityType }) => entityType === ORDER_ENTITY_TYPE,
    ).length,
    1,
  );
  assert.equal(
    [...records.values()].filter(
      ({ entityType }) => entityType === IDEMPOTENCY_ENTITY_TYPE,
    ).length,
    1,
  );
});

test("uses a safe default when a paused configuration has no valid message", async () => {
  const records = new Map([
    [
      ORDERING_CONFIG_ID,
      {
        orderId: ORDERING_CONFIG_ID,
        entityType: ORDERING_CONFIG_ENTITY_TYPE,
        acceptingOrders: false,
        message: " ",
      },
    ],
  ]);
  const { handler } = buildHandler({ records });

  const response = await handler(eventFor(frontendOrder));

  assert.equal(response.statusCode, 503);
  assert.equal(
    responseBody(response).error.message,
    DEFAULT_PAUSED_MESSAGE,
  );
});

test("uses the paused message returned by DynamoDB's raw cancellation item", async () => {
  const pauseMessage = "Orders are paused for twenty minutes.";
  const calls = [];
  const documentClient = {
    async send(command) {
      calls.push(command);
      const input = command.input;

      if (input.Key?.id === MENU_RECORD_ID) {
        return { Item: structuredClone(liveMenu) };
      }

      if (input.TransactItems) {
        const error = new Error("ordering is paused");
        error.name = "TransactionCanceledException";
        error.CancellationReasons = [
          {
            Code: "ConditionalCheckFailed",
            Item: {
              orderId: { S: ORDERING_CONFIG_ID },
              entityType: { S: ORDERING_CONFIG_ENTITY_TYPE },
              acceptingOrders: { BOOL: false },
              message: { S: pauseMessage },
            },
          },
          { Code: "None" },
          { Code: "None" },
        ];
        throw error;
      }

      if (input.Key?.orderId) {
        return {};
      }

      throw new Error("Unexpected test command");
    },
  };
  const { handler } = buildHandler({ documentClient });

  const response = await handler(eventFor(frontendOrder));

  assert.equal(response.statusCode, 503);
  assert.equal(responseBody(response).error.message, pauseMessage);
  assert.equal(calls.length, 4);
});

test("returns an idempotent replay even after ordering is paused", async () => {
  const { handler, calls, records } = buildHandler();
  const created = await handler(eventFor(frontendOrder));
  records.set(ORDERING_CONFIG_ID, {
    orderId: ORDERING_CONFIG_ID,
    entityType: ORDERING_CONFIG_ENTITY_TYPE,
    acceptingOrders: false,
    message: "Ordering is paused.",
  });
  const firstCallCount = calls.length;

  const replay = await handler(eventFor(frontendOrder));

  assert.equal(created.statusCode, 201);
  assert.equal(replay.statusCode, 200);
  assert.equal(responseBody(replay).idempotentReplay, true);
  assert.equal(responseBody(replay).orderId, responseBody(created).orderId);
  assert.equal(calls.length, firstCallCount + 2);
  assert.ok(
    calls
      .slice(firstCallCount)
      .every(({ input }) => input.TableName === "orders-test"),
  );
});

test("resolves a concurrent duplicate transaction as an idempotent replay", async () => {
  const records = new Map();
  const calls = [];
  let markerReadCount = 0;
  const documentClient = {
    async send(command) {
      calls.push(command);
      const input = command.input;

      if (input.Key?.id === MENU_RECORD_ID) {
        return { Item: structuredClone(liveMenu) };
      }

      if (input.TransactItems) {
        input.TransactItems
          .filter(({ Put }) => Put)
          .forEach(({ Put }) => {
            records.set(Put.Item.orderId, structuredClone(Put.Item));
          });
        const error = new Error("another invocation won the race");
        error.name = "TransactionCanceledException";
        throw error;
      }

      if (input.Key?.orderId) {
        markerReadCount += input.Key.orderId.startsWith("IDEMPOTENCY#") ? 1 : 0;
        const item = records.get(input.Key.orderId);
        return item ? { Item: structuredClone(item) } : {};
      }

      throw new Error("Unexpected test command");
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(eventFor(frontendOrder));

  assert.equal(response.statusCode, 200);
  assert.equal(responseBody(response).idempotentReplay, true);
  assert.equal(markerReadCount, 2);
});

test("returns sanitized errors for configuration and DynamoDB failures", async () => {
  const missingConfig = buildHandler({ ordersTableName: "" });
  const missingConfigResponse = await missingConfig.handler(
    eventFor(frontendOrder),
  );
  assert.equal(missingConfigResponse.statusCode, 500);
  assert.equal(missingConfig.calls.length, 0);

  const documentClient = {
    async send() {
      const error = new Error("secret AWS failure detail");
      error.name = "ProvisionedThroughputExceededException";
      throw error;
    },
  };
  const failing = buildHandler({ documentClient });
  const failingResponse = await failing.handler(eventFor(frontendOrder));

  assert.equal(failingResponse.statusCode, 500);
  assert.equal(responseBody(failingResponse).error.code, "INTERNAL_ERROR");
  assert.ok(!failingResponse.body.includes("secret AWS failure detail"));
});
