"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ANNOUNCEMENT_KEY_PREFIX,
  RESTAURANT_KEY,
  createGetAnnouncementsHandler,
} = require("../handler/get-announcements");

const currentTime = "2026-08-01T20:00:00.000Z";
const adminClaims = {
  sub: "admin-user-123",
  "cognito:groups": "customers,admin",
};
const silentLogger = { error() {} };

const storedAnnouncement = (overrides = {}) => {
  const announcementId =
    overrides.announcementId ||
    "ann_550e8400-e29b-41d4-a716-446655440000";

  return {
    pk: RESTAURANT_KEY,
    sk: `${ANNOUNCEMENT_KEY_PREFIX}${announcementId}`,
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
    createdAt: "2026-07-29T05:00:00.000Z",
    updatedAt: "2026-07-29T05:00:00.000Z",
    updatedBy: "admin-secret-sub",
    ...overrides,
  };
};

const publicEvent = () => ({
  httpMethod: "GET",
  resource: "/announcements",
});

const privateEvent = (claims = adminClaims) => ({
  httpMethod: "GET",
  resource: "/announcements/private",
  requestContext: { authorizer: { claims } },
});

const responseBody = (response) => JSON.parse(response.body);

const buildHandler = (overrides = {}) => {
  const calls = [];
  const pages = structuredClone(
    overrides.pages || [{ Items: [storedAnnouncement()] }],
  );
  const documentClient = overrides.documentClient || {
    async send(command) {
      calls.push(command);
      return pages.shift() || { Items: [] };
    },
  };

  return {
    calls,
    handler: createGetAnnouncementsHandler({
      documentClient,
      tableName: "restaurant-content-test",
      allowedOrigin: "https://sushi.example",
      adminGroupName: "admin",
      now: () => new Date(currentTime),
      logger: silentLogger,
      ...overrides,
    }),
  };
};

test("public GET queries announcement records and returns active published data", async () => {
  const { handler, calls } = buildHandler();

  const response = await handler(publicEvent());
  const body = responseBody(response);

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    TableName: "restaurant-content-test",
    KeyConditionExpression:
      "#pk = :restaurant AND begins_with(#sk, :announcementPrefix)",
    ExpressionAttributeNames: {
      "#pk": "pk",
      "#sk": "sk",
    },
    ExpressionAttributeValues: {
      ":restaurant": RESTAURANT_KEY,
      ":announcementPrefix": ANNOUNCEMENT_KEY_PREFIX,
    },
    ConsistentRead: true,
  });
  assert.deepEqual(body, {
    announcements: [
      {
        announcementId:
          "ann_550e8400-e29b-41d4-a716-446655440000",
        type: "DISCOUNT",
        title: "Friday special",
        message: "Save on selected dishes.",
        promoCode: "FRIDAY20",
        status: "PUBLISHED",
        startsAt: "2026-08-01T17:00:00.000Z",
        endsAt: "2026-08-02T00:00:00.000Z",
        priority: 20,
        createdAt: "2026-07-29T05:00:00.000Z",
        updatedAt: "2026-07-29T05:00:00.000Z",
      },
    ],
  });
  assert.ok(!Object.hasOwn(body.announcements[0], "pk"));
  assert.ok(!Object.hasOwn(body.announcements[0], "sk"));
  assert.ok(!Object.hasOwn(body.announcements[0], "entityType"));
  assert.ok(!Object.hasOwn(body.announcements[0], "updatedBy"));
});

test("public GET filters drafts and inactive announcements with exact boundaries", async () => {
  const items = [
    storedAnnouncement({
      announcementId:
        "ann_00000000-0000-4000-8000-000000000001",
      title: "Starts now",
      startsAt: currentTime,
      endsAt: "2026-08-01T21:00:00.000Z",
    }),
    storedAnnouncement({
      announcementId:
        "ann_00000000-0000-4000-8000-000000000002",
      status: "DRAFT",
    }),
    storedAnnouncement({
      announcementId:
        "ann_00000000-0000-4000-8000-000000000003",
      startsAt: "2026-08-01T21:00:00.000Z",
      endsAt: "2026-08-01T22:00:00.000Z",
    }),
    storedAnnouncement({
      announcementId:
        "ann_00000000-0000-4000-8000-000000000004",
      startsAt: "2026-08-01T18:00:00.000Z",
      endsAt: currentTime,
    }),
  ];
  const { handler } = buildHandler({ pages: [{ Items: items }] });

  const response = await handler(publicEvent());
  const announcements = responseBody(response).announcements;

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    announcements.map(({ title }) => title),
    ["Starts now"],
  );
});

test("public announcements sort by priority then newest start time", async () => {
  const items = [
    storedAnnouncement({
      announcementId:
        "ann_00000000-0000-4000-8000-000000000001",
      priority: 10,
      startsAt: "2026-08-01T16:00:00.000Z",
    }),
    storedAnnouncement({
      announcementId:
        "ann_00000000-0000-4000-8000-000000000002",
      priority: 30,
      startsAt: "2026-08-01T15:00:00.000Z",
    }),
    storedAnnouncement({
      announcementId:
        "ann_00000000-0000-4000-8000-000000000003",
      priority: 30,
      startsAt: "2026-08-01T18:00:00.000Z",
    }),
  ];
  const { handler } = buildHandler({ pages: [{ Items: items }] });

  const response = await handler(publicEvent());

  assert.deepEqual(
    responseBody(response).announcements.map(
      ({ announcementId }) => announcementId,
    ),
    [
      "ann_00000000-0000-4000-8000-000000000003",
      "ann_00000000-0000-4000-8000-000000000002",
      "ann_00000000-0000-4000-8000-000000000001",
    ],
  );
});

test("private GET requires an administrator and returns drafts newest-updated first", async () => {
  const older = storedAnnouncement({
    announcementId:
      "ann_00000000-0000-4000-8000-000000000001",
    status: "DRAFT",
    updatedAt: "2026-07-29T05:00:00.000Z",
  });
  const newer = storedAnnouncement({
    announcementId:
      "ann_00000000-0000-4000-8000-000000000002",
    status: "DRAFT",
    updatedAt: "2026-07-30T05:00:00.000Z",
  });
  const { handler } = buildHandler({
    pages: [{ Items: [older, newer] }],
  });

  const response = await handler(privateEvent());
  const announcements = responseBody(response).announcements;

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    announcements.map(({ announcementId }) => announcementId),
    [newer.announcementId, older.announcementId],
  );
  assert.equal(announcements[0].updatedBy, "admin-secret-sub");
  assert.ok(!Object.hasOwn(announcements[0], "pk"));
  assert.ok(!Object.hasOwn(announcements[0], "sk"));
});

test("private GET rejects missing identities and non-admin users before querying", async () => {
  const { handler, calls } = buildHandler();

  const unauthenticated = await handler(privateEvent({}));
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(
    responseBody(unauthenticated).error.code,
    "UNAUTHORIZED",
  );

  const customer = await handler(
    privateEvent({
      sub: "customer-123",
      "cognito:groups": "customers",
    }),
  );
  assert.equal(customer.statusCode, 403);
  assert.equal(responseBody(customer).error.code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("private GET accepts HTTP API claims and common group encodings", async () => {
  for (const groups of [
    ["customer", "admin"],
    "[\"customer\",\"admin\"]",
    "customer, admin",
  ]) {
    const { handler } = buildHandler();
    const event = privateEvent();
    event.requestContext.authorizer = {
      jwt: {
        claims: {
          sub: "admin-123",
          "cognito:groups": groups,
        },
      },
    };

    const response = await handler(event);
    assert.equal(response.statusCode, 200, JSON.stringify(groups));
  }
});

test("queries every DynamoDB page", async () => {
  const first = storedAnnouncement({
    announcementId:
      "ann_00000000-0000-4000-8000-000000000001",
  });
  const second = storedAnnouncement({
    announcementId:
      "ann_00000000-0000-4000-8000-000000000002",
  });
  const lastKey = { pk: RESTAURANT_KEY, sk: first.sk };
  const { handler, calls } = buildHandler({
    pages: [
      { Items: [first], LastEvaluatedKey: lastKey },
      { Items: [second] },
    ],
  });

  const response = await handler(publicEvent());

  assert.equal(response.statusCode, 200);
  assert.equal(responseBody(response).announcements.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].input.ExclusiveStartKey, lastKey);
});

test("ignores malformed and non-announcement records", async () => {
  const malformed = storedAnnouncement({
    announcementId:
      "ann_00000000-0000-4000-8000-000000000001",
    priority: "100",
  });
  const otherEntity = {
    pk: RESTAURANT_KEY,
    sk: "OPENING_HOURS",
    entityType: "OPENING_HOURS",
  };
  const { handler } = buildHandler({
    pages: [{ Items: [malformed, otherEntity] }],
  });

  const response = await handler(publicEvent());

  assert.deepEqual(responseBody(response), { announcements: [] });
});

test("handles unsupported methods, missing configuration, and DynamoDB errors safely", async () => {
  const { handler, calls } = buildHandler();
  const unsupported = await handler({
    ...publicEvent(),
    httpMethod: "POST",
  });
  assert.equal(unsupported.statusCode, 405);
  assert.equal(
    responseBody(unsupported).error.code,
    "METHOD_NOT_ALLOWED",
  );
  assert.equal(calls.length, 0);

  const missingConfiguration = buildHandler({
    tableName: "",
  });
  const missingResponse =
    await missingConfiguration.handler(publicEvent());
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
  const failedResponse = await failed.handler(publicEvent());
  assert.equal(failedResponse.statusCode, 500);
  assert.equal(
    responseBody(failedResponse).error.message,
    "The announcements could not be loaded.",
  );
  assert.ok(!failedResponse.body.includes("credentials"));
});
