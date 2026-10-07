"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_BODY_BYTES,
  RESTAURANT_KEY,
  createManageAnnouncementsHandler,
} = require("../handler/manage-announcements");

const fixedUuid = "550e8400-e29b-41d4-a716-446655440000";
const announcementId = `ann_${fixedUuid}`;
const createdAt = "2026-07-29T05:00:00.000Z";
const updatedAt = "2026-07-30T05:00:00.000Z";
const adminClaims = {
  sub: " admin-user-123 ",
  "cognito:groups": "customers,admin",
};
const silentLogger = { error() {} };

const content = (overrides = {}) => ({
  type: "DISCOUNT",
  title: " Friday special ",
  message: " Save on selected dishes. ",
  promoCode: "FRIDAY20",
  status: "PUBLISHED",
  startsAt: "2026-08-01T17:00:00.000Z",
  endsAt: "2026-08-02T00:00:00.000Z",
  priority: 20,
  ...overrides,
});

const eventFor = (
  method,
  body,
  claims = adminClaims,
  id = announcementId,
) => ({
  httpMethod: method,
  body: typeof body === "string" ? body : JSON.stringify(body),
  pathParameters:
    method === "POST" ? undefined : { announcementId: id },
  requestContext: { authorizer: { claims } },
});

const storedAnnouncement = (overrides = {}) => ({
  pk: RESTAURANT_KEY,
  sk: `ANNOUNCEMENT#${announcementId}`,
  entityType: "ANNOUNCEMENT",
  announcementId,
  type: "GENERAL",
  title: "Updated title",
  message: "Updated message",
  status: "DRAFT",
  startsAt: "2026-08-03T17:00:00.000Z",
  endsAt: "2026-08-04T00:00:00.000Z",
  priority: 5,
  createdAt,
  updatedAt,
  updatedBy: "admin-user-123",
  ...overrides,
});

const responseBody = (response) =>
  response.body ? JSON.parse(response.body) : undefined;

const buildHandler = (overrides = {}) => {
  const calls = [];
  const documentClient = overrides.documentClient || {
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "UpdateCommand") {
        return { Attributes: storedAnnouncement() };
      }
      return {};
    },
  };

  return {
    calls,
    handler: createManageAnnouncementsHandler({
      documentClient,
      tableName: "restaurant-content-test",
      allowedOrigin: "https://sushi.example",
      adminGroupName: "admin",
      randomUUID: () => fixedUuid,
      now: () => new Date(createdAt),
      logger: silentLogger,
      ...overrides,
    }),
  };
};

test("POST creates a server-owned announcement with a conditional put", async () => {
  const { handler, calls } = buildHandler();

  const response = await handler(eventFor("POST", content()));
  const body = responseBody(response);

  assert.equal(response.statusCode, 201);
  assert.equal(
    response.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    TableName: "restaurant-content-test",
    Item: {
      pk: RESTAURANT_KEY,
      sk: `ANNOUNCEMENT#${announcementId}`,
      entityType: "ANNOUNCEMENT",
      announcementId,
      type: "DISCOUNT",
      title: "Friday special",
      message: "Save on selected dishes.",
      promoCode: "FRIDAY20",
      status: "PUBLISHED",
      startsAt: "2026-08-01T17:00:00.000Z",
      endsAt: "2026-08-02T00:00:00.000Z",
      priority: 20,
      createdAt,
      updatedAt: createdAt,
      updatedBy: "admin-user-123",
    },
    ConditionExpression:
      "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
    ExpressionAttributeNames: {
      "#pk": "pk",
      "#sk": "sk",
    },
  });
  assert.deepEqual(body.announcement, {
    announcementId,
    type: "DISCOUNT",
    title: "Friday special",
    message: "Save on selected dishes.",
    promoCode: "FRIDAY20",
    status: "PUBLISHED",
    startsAt: "2026-08-01T17:00:00.000Z",
    endsAt: "2026-08-02T00:00:00.000Z",
    priority: 20,
    createdAt,
    updatedAt: createdAt,
    updatedBy: "admin-user-123",
  });
  assert.ok(!Object.hasOwn(body.announcement, "pk"));
  assert.ok(!Object.hasOwn(body.announcement, "sk"));
});

test("requires Cognito authentication and administrator membership", async () => {
  const { handler, calls } = buildHandler();

  const unauthenticated = await handler(
    eventFor("POST", content(), {}),
  );
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(
    responseBody(unauthenticated).error.code,
    "UNAUTHORIZED",
  );

  const customer = await handler(
    eventFor("POST", content(), {
      sub: "customer-123",
      "cognito:groups": "customers",
    }),
  );
  assert.equal(customer.statusCode, 403);
  assert.equal(responseBody(customer).error.code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("supports HTTP API claims and common Cognito group formats", async () => {
  for (const groups of [
    ["customer", "admin"],
    "[\"customer\",\"admin\"]",
    "customer, admin",
  ]) {
    const { handler } = buildHandler();
    const event = eventFor("POST", content());
    event.requestContext.authorizer = {
      jwt: {
        claims: {
          sub: "admin-123",
          "cognito:groups": groups,
        },
      },
    };

    const response = await handler(event);
    assert.equal(response.statusCode, 201, JSON.stringify(groups));
  }
});

test("POST requires complete exact fields", async () => {
  for (const body of [
    {},
    { ...content(), title: undefined },
    { ...content(), unknown: "not allowed" },
    [],
  ]) {
    if (isObjectWithUndefined(body)) {
      delete body.title;
    }
    const { handler, calls } = buildHandler();
    const response = await handler(eventFor("POST", body));
    assert.equal(response.statusCode, 422, JSON.stringify(body));
    assert.equal(
      responseBody(response).error.code,
      "VALIDATION_ERROR",
    );
    assert.equal(calls.length, 0);
  }
});

function isObjectWithUndefined(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.title === undefined
  );
}

test("validates types, statuses, content lengths, priorities, and time order", async () => {
  const invalidBodies = [
    content({ type: "SALE" }),
    content({ status: "ACTIVE" }),
    content({ title: " " }),
    content({ title: "x".repeat(101) }),
    content({ message: "" }),
    content({ message: "x".repeat(1001) }),
    content({ priority: 1.5 }),
    content({ priority: -1 }),
    content({ priority: 101 }),
    content({ startsAt: "2026-08-01T17:00:00Z" }),
    content({ endsAt: "2026-08-01T17:00:00.000Z" }),
  ];

  for (const body of invalidBodies) {
    const { handler, calls } = buildHandler();
    const response = await handler(eventFor("POST", body));
    assert.equal(response.statusCode, 422, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
});

test("promo codes are optional, uppercase, and exclusive to discounts", async () => {
  const validWithoutPromo = content({ promoCode: undefined });
  delete validWithoutPromo.promoCode;
  const valid = buildHandler();
  const validResponse = await valid.handler(
    eventFor("POST", validWithoutPromo),
  );
  assert.equal(validResponse.statusCode, 201);
  assert.ok(!Object.hasOwn(valid.calls[0].input.Item, "promoCode"));

  for (const body of [
    content({ promoCode: "friday20" }),
    content({ promoCode: "" }),
    content({ promoCode: "X".repeat(33) }),
    content({ type: "GENERAL", promoCode: "GENERAL10" }),
  ]) {
    const { handler, calls } = buildHandler();
    const response = await handler(eventFor("POST", body));
    assert.equal(response.statusCode, 422, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
});

test("accepts base64 JSON and rejects malformed, missing, and oversized bodies", async () => {
  const encoded = eventFor("POST", content());
  encoded.body = Buffer.from(encoded.body, "utf8").toString("base64");
  encoded.isBase64Encoded = true;
  const successful = buildHandler();
  const successResponse = await successful.handler(encoded);
  assert.equal(successResponse.statusCode, 201);

  for (const event of [
    eventFor("POST", "{not-json"),
    {
      httpMethod: "POST",
      requestContext: { authorizer: { claims: adminClaims } },
    },
    eventFor("POST", "x".repeat(MAX_BODY_BYTES + 1)),
  ]) {
    const { handler, calls } = buildHandler();
    const response = await handler(event);
    assert.ok([400, 413].includes(response.statusCode));
    assert.equal(calls.length, 0);
  }
});

test("PATCH replaces all editable fields with optimistic concurrency", async () => {
  const patch = {
    type: "GENERAL",
    title: "Updated title",
    message: "Updated message",
    status: "DRAFT",
    startsAt: "2026-08-03T17:00:00.000Z",
    endsAt: "2026-08-04T00:00:00.000Z",
    priority: 5,
    expectedUpdatedAt: createdAt,
  };
  const { handler, calls } = buildHandler({
    now: () => new Date(updatedAt),
  });

  const response = await handler(eventFor("PATCH", patch));

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  const input = calls[0].input;
  assert.deepEqual(input.Key, {
    pk: RESTAURANT_KEY,
    sk: `ANNOUNCEMENT#${announcementId}`,
  });
  assert.match(input.UpdateExpression, /^SET /u);
  assert.match(input.UpdateExpression, / REMOVE #promoCode$/u);
  assert.equal(
    input.ConditionExpression,
    "#entityType = :announcementType AND " +
      "#announcementId = :announcementId AND " +
      "#updatedAt = :expectedUpdatedAt",
  );
  assert.equal(
    input.ExpressionAttributeValues[":expectedUpdatedAt"],
    createdAt,
  );
  assert.equal(
    input.ExpressionAttributeValues[":updatedAt"],
    updatedAt,
  );
  assert.equal(
    input.ExpressionAttributeValues[":updatedBy"],
    "admin-user-123",
  );
  assert.equal(input.ReturnValues, "ALL_NEW");
  assert.deepEqual(responseBody(response), {
    announcement: {
      announcementId,
      type: "GENERAL",
      title: "Updated title",
      message: "Updated message",
      status: "DRAFT",
      startsAt: "2026-08-03T17:00:00.000Z",
      endsAt: "2026-08-04T00:00:00.000Z",
      priority: 5,
      createdAt,
      updatedAt,
      updatedBy: "admin-user-123",
    },
  });
});

test("PATCH always advances the optimistic-concurrency timestamp", async () => {
  const { handler, calls } = buildHandler({
    now: () => new Date(createdAt),
  });

  const response = await handler(
    eventFor("PATCH", {
      type: "GENERAL",
      title: "Updated title",
      message: "Updated message",
      status: "DRAFT",
      startsAt: "2026-08-03T17:00:00.000Z",
      endsAt: "2026-08-04T00:00:00.000Z",
      priority: 5,
      expectedUpdatedAt: createdAt,
    }),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].input.ExpressionAttributeValues[":updatedAt"],
    "2026-07-29T05:00:00.001Z",
  );
});

test("PATCH sets a discount promo code and requires a complete current version", async () => {
  const patch = {
    ...content(),
    expectedUpdatedAt: createdAt,
  };
  const withPromo = buildHandler({
    documentClient: {
      async send(command) {
        return {
          Attributes: storedAnnouncement({
            type: "DISCOUNT",
            promoCode: "FRIDAY20",
          }),
        };
      },
    },
  });

  const response = await withPromo.handler(
    eventFor("PATCH", patch),
  );
  assert.equal(response.statusCode, 200);

  const missingVersion = { ...patch };
  delete missingVersion.expectedUpdatedAt;
  const invalid = buildHandler();
  const invalidResponse = await invalid.handler(
    eventFor("PATCH", missingVersion),
  );
  assert.equal(invalidResponse.statusCode, 422);
  assert.equal(invalid.calls.length, 0);
});

test("DELETE requires only expectedUpdatedAt and uses a conditional delete", async () => {
  const { handler, calls } = buildHandler();

  const response = await handler(
    eventFor("DELETE", { expectedUpdatedAt: createdAt }),
  );

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  assert.deepEqual(calls[0].input, {
    TableName: "restaurant-content-test",
    Key: {
      pk: RESTAURANT_KEY,
      sk: `ANNOUNCEMENT#${announcementId}`,
    },
    ConditionExpression:
      "#entityType = :announcementType AND " +
      "#announcementId = :announcementId AND " +
      "#updatedAt = :expectedUpdatedAt",
    ExpressionAttributeNames: {
      "#entityType": "entityType",
      "#announcementId": "announcementId",
      "#updatedAt": "updatedAt",
    },
    ExpressionAttributeValues: {
      ":announcementType": "ANNOUNCEMENT",
      ":announcementId": announcementId,
      ":expectedUpdatedAt": createdAt,
    },
  });

  for (const body of [
    {},
    { expectedUpdatedAt: "not-a-time" },
    { expectedUpdatedAt: createdAt, force: true },
  ]) {
    const invalid = buildHandler();
    const invalidResponse = await invalid.handler(
      eventFor("DELETE", body),
    );
    assert.equal(invalidResponse.statusCode, 422);
    assert.equal(invalid.calls.length, 0);
  }
});

test("rejects invalid item paths and unsupported methods before DynamoDB", async () => {
  const invalidPath = buildHandler();
  const pathResponse = await invalidPath.handler(
    eventFor(
      "PATCH",
      { ...content(), expectedUpdatedAt: createdAt },
      adminClaims,
      "ann_bad",
    ),
  );
  assert.equal(pathResponse.statusCode, 400);
  assert.equal(
    responseBody(pathResponse).error.code,
    "INVALID_ANNOUNCEMENT_ID",
  );
  assert.equal(invalidPath.calls.length, 0);

  const unsupported = buildHandler();
  const methodResponse = await unsupported.handler(
    eventFor("PUT", content()),
  );
  assert.equal(methodResponse.statusCode, 405);
  assert.equal(
    responseBody(methodResponse).error.code,
    "METHOD_NOT_ALLOWED",
  );
  assert.equal(unsupported.calls.length, 0);
});

test("maps stale PATCH and DELETE conditions to conflicts", async () => {
  const conditionalError = new Error("condition failed");
  conditionalError.name = "ConditionalCheckFailedException";

  for (const [method, body] of [
    [
      "PATCH",
      { ...content(), expectedUpdatedAt: createdAt },
    ],
    ["DELETE", { expectedUpdatedAt: createdAt }],
  ]) {
    const { handler } = buildHandler({
      documentClient: {
        async send() {
          throw conditionalError;
        },
      },
    });

    const response = await handler(eventFor(method, body));
    assert.equal(response.statusCode, 409);
    assert.equal(
      responseBody(response).error.code,
      "ANNOUNCEMENT_CONFLICT",
    );
  }
});

test("handles missing configuration, DynamoDB failures, and invalid update returns safely", async () => {
  const missing = buildHandler({ tableName: "" });
  const missingResponse = await missing.handler(
    eventFor("POST", content()),
  );
  assert.equal(missingResponse.statusCode, 500);
  assert.equal(
    responseBody(missingResponse).error.code,
    "INTERNAL_ERROR",
  );

  const failure = new Error("credentials and secret details");
  failure.name = "AccessDeniedException";
  const failed = buildHandler({
    documentClient: {
      async send() {
        throw failure;
      },
    },
  });
  const failedResponse = await failed.handler(
    eventFor("POST", content()),
  );
  assert.equal(failedResponse.statusCode, 500);
  assert.equal(
    responseBody(failedResponse).error.message,
    "The announcement could not be changed.",
  );
  assert.ok(!failedResponse.body.includes("credentials"));

  const invalidReturn = buildHandler({
    documentClient: {
      async send() {
        return { Attributes: { entityType: "OTHER" } };
      },
    },
  });
  const invalidResponse = await invalidReturn.handler(
    eventFor("PATCH", {
      ...content(),
      expectedUpdatedAt: createdAt,
    }),
  );
  assert.equal(invalidResponse.statusCode, 500);
});
