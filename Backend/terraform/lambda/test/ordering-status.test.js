"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_PAUSED_MESSAGE,
  MAX_BODY_BYTES,
  MAX_MESSAGE_LENGTH,
  ORDERING_CONFIG_ENTITY_TYPE,
  ORDERING_CONFIG_ID,
  createOrderingStatusHandler,
} = require("../handler/ordering-status");

const updatedAt = "2026-07-31T20:00:00.000Z";
const adminClaims = {
  sub: " admin-user-123 ",
  "cognito:groups": "customers,admin",
};
const silentLogger = { error() {} };

const eventFor = (method, body, claims = adminClaims) => ({
  httpMethod: method,
  ...(body === undefined
    ? {}
    : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  requestContext: { authorizer: { claims } },
});

const responseBody = (response) => JSON.parse(response.body);

const storedStatus = (overrides = {}) => ({
  orderId: ORDERING_CONFIG_ID,
  entityType: ORDERING_CONFIG_ENTITY_TYPE,
  acceptingOrders: false,
  message: "The kitchen is catching up.",
  updatedAt,
  updatedBy: "admin-user-123",
  ...overrides,
});

const buildHandler = (overrides = {}) => {
  const calls = [];
  const documentClient = overrides.documentClient || {
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "GetCommand") {
        return overrides.item
          ? { Item: structuredClone(overrides.item) }
          : {};
      }
      return {};
    },
  };

  return {
    calls,
    handler: createOrderingStatusHandler({
      documentClient,
      ordersTableName: "orders-test",
      allowedOrigin: "https://sushi.example",
      adminGroupName: "admin",
      now: () => new Date(updatedAt),
      logger: silentLogger,
      ...overrides,
    }),
  };
};

test("GET defaults to accepting orders when the configuration is missing", async () => {
  const { handler, calls } = buildHandler();

  const response = await handler(eventFor("GET", undefined, {}));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), {
    acceptingOrders: true,
    message: "",
  });
  assert.equal(
    response.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls[0].input, {
    TableName: "orders-test",
    Key: { orderId: ORDERING_CONFIG_ID },
    ConsistentRead: true,
  });
});

test("GET returns the stored public status without exposing the administrator", async () => {
  const { handler } = buildHandler({
    item: storedStatus({ message: "  The kitchen is catching up.  " }),
  });

  const response = await handler(eventFor("GET", undefined, {}));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), {
    acceptingOrders: false,
    message: "The kitchen is catching up.",
    updatedAt,
  });
  assert.ok(!Object.hasOwn(responseBody(response), "updatedBy"));
});

test("GET supplies a safe default for a stored paused status with a blank message", async () => {
  const { handler } = buildHandler({
    item: storedStatus({ message: " \n\t " }),
  });

  const response = await handler(eventFor("GET", undefined, {}));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), {
    acceptingOrders: false,
    message: DEFAULT_PAUSED_MESSAGE,
    updatedAt,
  });
});

test("PUT lets an administrator atomically replace the ordering status", async () => {
  const { handler, calls } = buildHandler();

  const response = await handler(
    eventFor("PUT", {
      acceptingOrders: false,
      message: "  The kitchen is catching up.  ",
    }),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), {
    acceptingOrders: false,
    message: "The kitchen is catching up.",
    updatedAt,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    TableName: "orders-test",
    Item: {
      orderId: ORDERING_CONFIG_ID,
      entityType: ORDERING_CONFIG_ENTITY_TYPE,
      acceptingOrders: false,
      message: "The kitchen is catching up.",
      updatedAt,
      updatedBy: "admin-user-123",
    },
  });
});

test("PUT requires authentication and exact administrator membership", async () => {
  const unauthenticated = buildHandler();
  const unauthorized = await unauthenticated.handler(
    eventFor("PUT", { acceptingOrders: true }, {}),
  );
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(responseBody(unauthorized).error.code, "UNAUTHORIZED");
  assert.equal(unauthenticated.calls.length, 0);

  const customer = buildHandler();
  const forbidden = await customer.handler(
    eventFor(
      "PUT",
      { acceptingOrders: true },
      { sub: "customer-123", "cognito:groups": "superadmin" },
    ),
  );
  assert.equal(forbidden.statusCode, 403);
  assert.equal(responseBody(forbidden).error.code, "FORBIDDEN");
  assert.equal(customer.calls.length, 0);
});

test("PUT accepts HTTP API claims and common Cognito group formats", async () => {
  for (const groups of [
    ["customers", "admin"],
    "[\"customers\",\"admin\"]",
    "customers, admin",
  ]) {
    const { handler } = buildHandler();
    const event = eventFor("PUT", { acceptingOrders: true });
    event.requestContext.authorizer = {
      jwt: {
        claims: { sub: "admin-123", "cognito:groups": groups },
      },
    };

    const response = await handler(event);
    assert.equal(response.statusCode, 200, JSON.stringify(groups));
  }
});

test("PUT validates the status and pause message before writing", async () => {
  const invalidBodies = [
    {},
    [],
    { acceptingOrders: "false", message: "Paused" },
    { acceptingOrders: false },
    { acceptingOrders: false, message: " " },
    { acceptingOrders: false, message: "x".repeat(MAX_MESSAGE_LENGTH + 1) },
    { acceptingOrders: true, unknown: true },
  ];

  for (const body of invalidBodies) {
    const { handler, calls } = buildHandler();
    const response = await handler(eventFor("PUT", body));
    assert.equal(response.statusCode, 422, JSON.stringify(body));
    assert.equal(responseBody(response).error.code, "VALIDATION_ERROR");
    assert.equal(calls.length, 0);
  }

  for (const event of [
    eventFor("PUT", "{not-json"),
    eventFor("PUT", "x".repeat(MAX_BODY_BYTES + 1)),
    {
      httpMethod: "PUT",
      requestContext: { authorizer: { claims: adminClaims } },
    },
  ]) {
    const { handler, calls } = buildHandler();
    const response = await handler(event);
    assert.ok([400, 413].includes(response.statusCode));
    assert.equal(calls.length, 0);
  }
});

test("returns sanitized failures for invalid storage, configuration, and DynamoDB", async () => {
  const invalidStored = buildHandler({
    item: storedStatus({ acceptingOrders: "no" }),
  });
  const invalidStoredResponse = await invalidStored.handler(
    eventFor("GET", undefined, {}),
  );
  assert.equal(invalidStoredResponse.statusCode, 500);
  assert.equal(responseBody(invalidStoredResponse).error.code, "INTERNAL_ERROR");
  assert.ok(!invalidStoredResponse.body.includes("Invalid stored"));

  const missingConfiguration = buildHandler({ ordersTableName: "" });
  const missingResponse = await missingConfiguration.handler(
    eventFor("GET", undefined, {}),
  );
  assert.equal(missingResponse.statusCode, 500);
  assert.equal(missingConfiguration.calls.length, 0);

  const failure = new Error("secret database details");
  failure.name = "AccessDeniedException";
  const failed = buildHandler({
    documentClient: { async send() { throw failure; } },
  });
  const failedResponse = await failed.handler(
    eventFor("GET", undefined, {}),
  );
  assert.equal(failedResponse.statusCode, 500);
  assert.ok(!failedResponse.body.includes("secret database details"));
});

test("rejects unsupported methods without touching DynamoDB", async () => {
  const { handler, calls } = buildHandler();

  const response = await handler(eventFor("POST", {}));

  assert.equal(response.statusCode, 405);
  assert.equal(responseBody(response).error.code, "METHOD_NOT_ALLOWED");
  assert.equal(calls.length, 0);
});
