"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createReplaceDishesHandler,
} = require("../handler/replace-dishes");

const fixedNow = new Date("2026-07-16T12:00:00.000Z");
const fixedVersion = fixedNow.getTime();

const akami = {
  id: "akami",
  category: "Nigiri",
  name: "Bluefin akami",
  description: "Lean bluefin and seasoned rice.",
  price: "14",
  availability: "available",
};

const soraRoll = {
  id: "sora-roll",
  category: "Maki",
  name: "Sora house roll",
  description: "Snow crab and avocado.",
  price: "24",
  availability: "available",
};

const silentLogger = { error() {} };

const eventFor = (
  body,
  claims = { sub: "user-123", "cognito:groups": "admin" },
) => ({
  body: typeof body === "string" ? body : JSON.stringify(body),
  requestContext: { authorizer: { claims } },
});

const buildHandler = (overrides = {}) => {
  const calls = [];
  const documentClient = overrides.documentClient || {
    async send(command) {
      calls.push({ name: command.constructor.name, input: command.input });
      return {};
    },
  };

  return {
    calls,
    handler: createReplaceDishesHandler({
      documentClient,
      tableName: "dishes-test",
      adminGroupName: "admin",
      allowedOrigin: "https://sushi.example",
      now: () => fixedNow,
      logger: silentLogger,
      ...overrides,
    }),
  };
};

const responseBody = (response) => JSON.parse(response.body);

test("atomically replaces the aggregate menu and preserves item order", async () => {
  const { handler, calls } = buildHandler();

  const response = await handler(eventFor({ items: [soraRoll, akami] }));

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.deepEqual(calls, [
    {
      name: "PutCommand",
      input: {
        TableName: "dishes-test",
        Item: {
          id: "MENU#CURRENT",
          items: [soraRoll, akami],
          version: fixedVersion,
          updatedAt: fixedNow.toISOString(),
          updatedBy: "user-123",
        },
      },
    },
  ]);
  assert.deepEqual(responseBody(response), {
    items: [soraRoll, akami],
    version: fixedVersion,
    updatedAt: fixedNow.toISOString(),
  });
});

test("trims every dish through the existing dish validator", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({
      items: [
        {
          id: " akami ",
          category: " Nigiri ",
          name: " Bluefin akami ",
          description: " Lean bluefin. ",
          price: " 14.50 ",
        },
      ],
    }),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls[0].input.Item.items, [
    {
      id: "akami",
      category: "Nigiri",
      name: "Bluefin akami",
      description: "Lean bluefin.",
      price: "14.50",
      availability: "available",
    },
  ]);
});

test("persists structured allergens and private RAG context", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({
      items: [
        {
          ...soraRoll,
          allergens: [
            "soy",
            "gluten",
            "shellfish",
            "wheat",
            "fish",
          ],
          fullDishInfo: "  Snow crab is delivered every Tuesday.  ",
          availability: " OUT ",
        },
      ],
    }),
  );

  const expectedDish = {
    ...soraRoll,
    allergens: ["fish", "shellfish", "wheat", "soy"],
    fullDishInfo: "Snow crab is delivered every Tuesday.",
    availability: "out",
  };
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls[0].input.Item.items, [expectedDish]);
  assert.deepEqual(responseBody(response).items, [expectedDish]);
});

test("persists normalized image metadata with the aggregate menu", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({
      items: [
        {
          ...soraRoll,
          image: {
            key: " dishes/sora-roll/550e8400-e29b-41d4-a716-446655440000.jpeg ",
            alt: "  Snow crab and avocado roll  ",
            width: 1200,
            height: 900,
          },
        },
      ],
    }),
  );

  const expectedDish = {
    ...soraRoll,
    image: {
      key: "dishes/sora-roll/550e8400-e29b-41d4-a716-446655440000.jpeg",
      alt: "Snow crab and avocado roll",
      width: 1200,
      height: 900,
    },
  };
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls[0].input.Item.items, [expectedDish]);
  assert.deepEqual(responseBody(response).items, [expectedDish]);
});

test("requires a Cognito identity and the configured admin group", async () => {
  const { handler, calls } = buildHandler();

  const unauthenticated = await handler(eventFor({ items: [akami] }, {}));
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(responseBody(unauthenticated).error.code, "UNAUTHORIZED");

  const notAdmin = await handler(
    eventFor(
      { items: [akami] },
      { sub: "user-123", "cognito:groups": "customers,editors" },
    ),
  );
  assert.equal(notAdmin.statusCode, 403);
  assert.equal(responseBody(notAdmin).error.code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("supports HTTP API JWT claims and common Cognito group formats", async () => {
  for (const groups of [
    ["customer", "admin"],
    "[\"customer\",\"admin\"]",
    "customer, admin",
  ]) {
    const { handler } = buildHandler();
    const event = eventFor({ items: [akami] });
    event.requestContext.authorizer = {
      jwt: {
        claims: { sub: "user-123", "cognito:groups": groups },
      },
    };

    const response = await handler(event);
    assert.equal(response.statusCode, 200, JSON.stringify(groups));
  }
});

test("accepts a base64-encoded request body", async () => {
  const { handler } = buildHandler();
  const event = eventFor({ items: [akami] });
  event.body = Buffer.from(event.body, "utf8").toString("base64");
  event.isBase64Encoded = true;

  const response = await handler(event);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response).items, [akami]);
});

test("rejects malformed, missing, and oversized JSON bodies", async () => {
  const { handler, calls } = buildHandler();

  const malformed = await handler(eventFor("{not-json"));
  assert.equal(malformed.statusCode, 400);
  assert.equal(responseBody(malformed).error.code, "INVALID_JSON");

  const missing = await handler({
    requestContext: {
      authorizer: {
        claims: { sub: "user-123", "cognito:groups": "admin" },
      },
    },
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(responseBody(missing).error.code, "INVALID_JSON");

  const oversized = await handler(eventFor("x".repeat(64 * 1024 + 1)));
  assert.equal(oversized.statusCode, 413);
  assert.equal(responseBody(oversized).error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(calls.length, 0);
});

test("requires an exact top-level object containing only items", async () => {
  const { handler, calls } = buildHandler();

  for (const body of [
    [akami],
    {},
    { items: [akami], restaurant: "Sora" },
  ]) {
    const response = await handler(eventFor(body));
    assert.equal(response.statusCode, 422);
    assert.equal(responseBody(response).error.code, "VALIDATION_ERROR");
  }

  const unknownFieldResponse = await handler(
    eventFor({ items: [akami], restaurant: "Sora" }),
  );
  const fields = responseBody(unknownFieldResponse).error.details.map(
    ({ field }) => field,
  );
  assert.ok(fields.includes("restaurant"));
  assert.equal(calls.length, 0);
});

test("requires between one and fifty dishes", async () => {
  const { handler, calls } = buildHandler();

  const empty = await handler(eventFor({ items: [] }));
  assert.equal(empty.statusCode, 422);
  assert.ok(
    responseBody(empty).error.details.some(({ field }) => field === "items"),
  );

  const tooManyItems = Array.from({ length: 51 }, (_, index) => ({
    ...akami,
    id: `dish-${index}`,
  }));
  const tooMany = await handler(eventFor({ items: tooManyItems }));
  assert.equal(tooMany.statusCode, 422);
  assert.ok(
    responseBody(tooMany).error.details.some(({ field }) => field === "items"),
  );
  assert.equal(calls.length, 0);
});

test("rejects duplicate normalized dish ids", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({
      items: [akami, { ...soraRoll, id: " akami " }],
    }),
  );

  assert.equal(response.statusCode, 422);
  assert.ok(
    responseBody(response).error.details.some(
      ({ field, message }) =>
        field === "items[1].id" && message.includes("unique"),
    ),
  );
  assert.equal(calls.length, 0);
});

test("requires the core dish fields and rejects unknown fields", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({
      items: [
        {
          id: "bad id",
          category: "Maki",
          name: " ",
          description: "",
          price: 24,
          availability: "sold-out",
          imageUrl: "https://example.com/roll.jpg",
        },
      ],
    }),
  );

  assert.equal(response.statusCode, 422);
  const fields = responseBody(response).error.details.map(({ field }) => field);
  for (const field of [
    "id",
    "name",
    "description",
    "price",
    "availability",
    "imageUrl",
  ]) {
    assert.ok(fields.includes(`items[0].${field}`), field);
  }
  assert.equal(calls.length, 0);
});

test("returns a sanitized error when DynamoDB fails", async () => {
  const documentClient = {
    async send() {
      const error = new Error("secret AWS failure details");
      error.name = "InternalServerError";
      throw error;
    },
  };
  const { handler } = buildHandler({ documentClient });

  const response = await handler(eventFor({ items: [akami] }));

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.ok(!response.body.includes("secret AWS failure details"));
});

test("returns a sanitized error when the table is not configured", async () => {
  let calls = 0;
  const documentClient = { async send() { calls += 1; } };
  const { handler } = buildHandler({ documentClient, tableName: "" });

  const response = await handler(eventFor({ items: [akami] }));

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.equal(calls, 0);
});
