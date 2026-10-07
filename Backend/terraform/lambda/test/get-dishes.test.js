"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGetDishesHandler } = require("../handler/get-dishes");

const silentLogger = { error() {} };

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
  availability: "out",
};

const soraRollImage = {
  key: "dishes/sora-roll/550e8400-e29b-41d4-a716-446655440000.webp",
  alt: "Sora house roll",
  width: 800,
  height: 600,
};

const buildHandler = (overrides = {}) => {
  const calls = [];
  const responses = overrides.responses || [{}, { Items: [] }];
  const documentClient = overrides.documentClient || {
    async send(command) {
      calls.push({ name: command.constructor.name, input: command.input });
      return responses.shift() || {};
    },
  };

  return {
    calls,
    handler: createGetDishesHandler({
      documentClient,
      tableName: "dishes-test",
      allowedOrigin: "https://sushi.example",
      logger: silentLogger,
      ...overrides,
    }),
  };
};

const responseBody = (response) => JSON.parse(response.body);

test("returns aggregate menu items in their stored order", async () => {
  const { handler, calls } = buildHandler({
    responses: [
      {
        Item: {
          id: "MENU#CURRENT",
          items: [soraRoll, akami],
          version: 123,
          updatedAt: "2026-07-16T12:00:00.000Z",
          updatedBy: "user-123",
        },
      },
    ],
  });

  const response = await handler();

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.deepEqual(responseBody(response), [soraRoll, akami]);
  assert.deepEqual(calls, [
    {
      name: "GetCommand",
      input: {
        TableName: "dishes-test",
        Key: { id: "MENU#CURRENT" },
        ConsistentRead: true,
      },
    },
  ]);
});

test("keeps private RAG context out of the public menu response", async () => {
  const privateDish = {
    ...soraRoll,
    allergens: ["wheat", "gluten", "shellfish", "fish"],
    fullDishInfo: "Crab is sourced from Hokkaido and the sauce contains wheat.",
    image: soraRollImage,
  };
  const { handler } = buildHandler({
    responses: [
      {
        Item: {
          id: "MENU#CURRENT",
          items: [privateDish],
        },
      },
    ],
  });

  const response = await handler();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), [
    {
      ...soraRoll,
      allergens: ["fish", "shellfish", "wheat"],
      image: soraRollImage,
    },
  ]);
  assert.ok(!response.body.includes("Hokkaido"));
  assert.ok(!response.body.includes("fullDishInfo"));
});

test("returns full dish metadata only to an authenticated admin route", async () => {
  const privateDish = {
    ...akami,
    allergens: [
      "sesame",
      "soy",
      "gluten",
      "wheat",
      "tree-nuts",
      "peanut",
      "egg",
      "milk",
      "shellfish",
      "fish",
    ],
    fullDishInfo: "The aged soy marinade is prepared in-house.",
    image: {
      key: "dishes/akami/13c201d6-d87e-48cd-93e9-503fc930c149.jpg",
      alt: "Bluefin akami nigiri",
      width: 1000,
      height: 750,
    },
  };
  const { handler } = buildHandler({
    responses: [
      {
        Item: {
          id: "MENU#CURRENT",
          items: [privateDish],
        },
      },
    ],
  });
  const event = {
    resource: "/dishes/private",
    requestContext: {
      authorizer: {
        claims: { sub: "admin-123", "cognito:groups": "admin" },
      },
    },
  };

  const response = await handler(event);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), [
    {
      ...privateDish,
      allergens: [
        "fish",
        "shellfish",
        "milk",
        "egg",
        "peanut",
        "tree-nuts",
        "wheat",
        "soy",
        "sesame",
      ],
    },
  ]);
});

test("normalizes legacy private dish context when loading stored menus", async () => {
  const legacyDish = {
    ...akami,
    ragInfo: "The legacy private preparation notes.",
  };
  const { handler } = buildHandler({
    responses: [
      {
        Item: {
          id: "MENU#CURRENT",
          items: [legacyDish],
        },
      },
    ],
  });
  const event = {
    resource: "/dishes/private",
    requestContext: {
      authorizer: {
        claims: { sub: "admin-123", "cognito:groups": "admin" },
      },
    },
  };

  const response = await handler(event);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), [
    {
      ...akami,
      fullDishInfo: "The legacy private preparation notes.",
    },
  ]);
  assert.ok(!response.body.includes("ragInfo"));
});

test("rejects unauthenticated and non-admin private menu reads", async () => {
  const unauthenticated = buildHandler();
  const unauthenticatedResponse = await unauthenticated.handler({
    resource: "/dishes/private",
  });
  assert.equal(unauthenticatedResponse.statusCode, 401);
  assert.equal(unauthenticated.calls.length, 0);

  const nonAdmin = buildHandler();
  const nonAdminResponse = await nonAdmin.handler({
    resource: "/dishes/private",
    requestContext: {
      authorizer: {
        claims: {
          sub: "user-123",
          "cognito:groups": "customers,editors",
        },
      },
    },
  });
  assert.equal(nonAdminResponse.statusCode, 403);
  assert.equal(nonAdmin.calls.length, 0);
});

test("trims and validates dishes loaded from the aggregate", async () => {
  const { handler } = buildHandler({
    responses: [
      {
        Item: {
          id: "MENU#CURRENT",
          items: [
            {
              id: " akami ",
              category: " Nigiri ",
              name: " Bluefin akami ",
              description: " Lean bluefin. ",
              price: " 14.50 ",
            },
          ],
        },
      },
    ],
  });

  const response = await handler();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), [
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

test("falls back to every legacy Scan page and sorts dishes by id", async () => {
  const calls = [];
  const pages = [
    {
      Items: [
        {
          ...soraRoll,
          image: soraRollImage,
          internalAttribute: "must not be returned",
        },
      ],
      LastEvaluatedKey: { id: "sora-roll" },
    },
    {
      Items: [
        {
          id: "akami",
          category: "Nigiri",
          name: "Bluefin akami",
          description: "Lean bluefin and seasoned rice.",
          price: "14",
        },
      ],
      LastEvaluatedKey: {},
    },
  ];
  const documentClient = {
    async send(command) {
      calls.push({ name: command.constructor.name, input: command.input });
      return command.constructor.name === "GetCommand" ? {} : pages.shift();
    },
  };
  const { handler } = buildHandler({ documentClient });

  const response = await handler();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), [
    akami,
    { ...soraRoll, image: soraRollImage },
  ]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].name, "GetCommand");
  assert.equal(calls[1].name, "ScanCommand");
  assert.equal(calls[1].input.ExclusiveStartKey, undefined);
  assert.deepEqual(calls[2].input.ExclusiveStartKey, { id: "sora-roll" });
  assert.equal(
    calls[1].input.ProjectionExpression,
    "#id, #category, #name, #description, #price, #allergens, #fullDishInfo, #legacyFullDishInfo, #image, #availability",
  );
  assert.equal(
    calls[1].input.ExpressionAttributeNames["#legacyFullDishInfo"],
    "ragInfo",
  );
  assert.equal(calls[1].input.ExpressionAttributeNames["#image"], "image");
  assert.equal(
    calls[1].input.ExpressionAttributeNames["#availability"],
    "availability",
  );
});

test("returns an empty array for an empty table without authentication", async () => {
  const { handler, calls } = buildHandler();

  const response = await handler();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), []);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "GetCommand");
  assert.equal(calls[1].name, "ScanCommand");
});

test("continues after an empty legacy page when DynamoDB supplies a next key", async () => {
  const responses = [
    {},
    { Items: [], LastEvaluatedKey: { id: "cursor" } },
    {
      Items: [
        {
          id: "matcha",
          category: "Sweet",
          name: "Matcha cloud",
          description: "Matcha and black sesame.",
          price: "13",
        },
      ],
    },
  ];
  const { handler } = buildHandler({ responses });

  const response = await handler();

  assert.equal(response.statusCode, 200);
  assert.equal(responseBody(response)[0].id, "matcha");
});

test("does not interpret an aggregate record encountered by legacy Scan as a dish", async () => {
  const { handler } = buildHandler({
    responses: [
      {},
      {
        Items: [
          { id: "MENU#CURRENT", items: [soraRoll] },
          akami,
        ],
      },
    ],
  });

  const response = await handler();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), [akami]);
});

test("returns a sanitized error for an invalid aggregate menu", async () => {
  const { handler } = buildHandler({
    responses: [
      {
        Item: {
          id: "MENU#CURRENT",
          items: [{ ...soraRoll, price: undefined }],
        },
      },
    ],
  });

  const response = await handler();

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.ok(!response.body.includes("sora-roll"));
});

test("returns a sanitized error for an invalid legacy dish", async () => {
  const { handler } = buildHandler({
    responses: [
      {},
      {
        Items: [
          {
            id: "broken",
            category: "Maki",
            name: "Broken item",
            description: "Missing its price.",
          },
        ],
      },
    ],
  });

  const response = await handler();

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.ok(!response.body.includes("broken"));
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

  const response = await handler();

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.ok(!response.body.includes("secret AWS failure details"));
});

test("returns a sanitized error when the table is not configured", async () => {
  let calls = 0;
  const documentClient = { async send() { calls += 1; } };
  const { handler } = buildHandler({ documentClient, tableName: "" });

  const response = await handler();

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.equal(calls, 0);
});
