"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../handler/index");
const {
  ALLERGEN_TYPES,
  validateDishPayload,
} = require("../handler/validate-dish");

const frontendDish = {
  id: "sora-roll",
  category: "Maki",
  name: "Sora house roll",
  description: "Snow crab, avocado, cucumber, tuna, toasted sesame.",
  price: "24",
  availability: "available",
};

const frontendDishImage = {
  key: "dishes/sora-roll/550e8400-e29b-41d4-a716-446655440000.webp",
  alt: "Sora house roll",
  width: 800,
  height: 600,
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
      calls.push(command.input);
      return {};
    },
  };

  return {
    calls,
    handler: createHandler({
      documentClient,
      tableName: "dishes-test",
      adminGroupName: "admin",
      allowedOrigin: "https://sushi.example",
      logger: silentLogger,
      ...overrides,
    }),
  };
};

const responseBody = (response) => JSON.parse(response.body);

test("accepts, stores, and returns the exact frontend dish format", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(eventFor(frontendDish));

  assert.equal(response.statusCode, 201);
  assert.equal(
    response.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.deepEqual(calls, [
    {
      TableName: "dishes-test",
      Item: frontendDish,
      ReturnValues: "ALL_OLD",
    },
  ]);
  assert.deepEqual(responseBody(response), frontendDish);
});

test("trims strings while preserving price as a string", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({
      id: "  sora-roll  ",
      category: " Maki ",
      name: " Sora house roll ",
      description: " Snow crab and avocado. ",
      price: " 24.50 ",
      availability: " OUT ",
    }),
  );

  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls[0].Item, {
    id: "sora-roll",
    category: "Maki",
    name: "Sora house roll",
    description: "Snow crab and avocado.",
    price: "24.50",
    availability: "out",
  });
  assert.equal(typeof responseBody(response).price, "string");
});

test("accepts, normalizes, stores, and returns dish image metadata", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({
      ...frontendDish,
      image: {
        ...frontendDishImage,
        key: `  ${frontendDishImage.key}  `,
        alt: "  Sora house roll  ",
      },
    }),
  );

  const expected = { ...frontendDish, image: frontendDishImage };
  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls[0].Item, expected);
  assert.deepEqual(responseBody(response), expected);
});

test("updates a dish with the same id", async () => {
  const calls = [];
  const documentClient = {
    async send(command) {
      calls.push(command.input);
      return { Attributes: { ...frontendDish, price: "22" } };
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(eventFor(frontendDish));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), frontendDish);
  assert.equal(calls[0].ConditionExpression, undefined);
});

test("requires a Cognito identity and the configured admin group", async () => {
  const { handler, calls } = buildHandler();

  const unauthenticated = await handler(eventFor(frontendDish, {}));
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(responseBody(unauthenticated).error.code, "UNAUTHORIZED");

  const notAdmin = await handler(
    eventFor(frontendDish, {
      sub: "user-123",
      "cognito:groups": "customers,editors",
    }),
  );
  assert.equal(notAdmin.statusCode, 403);
  assert.equal(responseBody(notAdmin).error.code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("accepts JSON-array and comma-separated Cognito group claims", async () => {
  const first = buildHandler();
  const arrayClaimResponse = await first.handler(
    eventFor(frontendDish, {
      sub: "user-123",
      "cognito:groups": "[\"customer\",\"admin\"]",
    }),
  );

  const second = buildHandler();
  const commaClaimResponse = await second.handler(
    eventFor(frontendDish, {
      sub: "user-123",
      "cognito:groups": "customer, admin",
    }),
  );

  assert.equal(arrayClaimResponse.statusCode, 201);
  assert.equal(commaClaimResponse.statusCode, 201);
});

test("returns 400 for malformed or missing JSON", async () => {
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
  assert.equal(calls.length, 0);
});

test("requires the core frontend fields and rejects unknown fields", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({
      id: "bad id",
      category: "Maki",
      name: " ",
      description: "",
      price: 24,
      imageUrl: "https://example.com/roll.jpg",
    }),
  );

  assert.equal(response.statusCode, 422);
  const fields = responseBody(response).error.details.map(({ field }) => field);
  assert.ok(fields.includes("id"));
  assert.ok(fields.includes("name"));
  assert.ok(fields.includes("description"));
  assert.ok(fields.includes("price"));
  assert.ok(fields.includes("imageUrl"));
  assert.equal(calls.length, 0);
});

test("validates string prices", () => {
  assert.equal(validateDishPayload(frontendDish).value.price, "24");
  assert.equal(
    validateDishPayload({ ...frontendDish, price: "12.30" }).value.price,
    "12.30",
  );

  for (const price of [24, "-1", "1.001", "free", "100000.01"]) {
    const result = validateDishPayload({ ...frontendDish, price });
    assert.ok(result.errors.some(({ field }) => field === "price"), String(price));
  }
});

test("validates, normalizes, and safely defaults dish availability", () => {
  const normalized = validateDishPayload({
    ...frontendDish,
    availability: "  OUT  ",
  });
  assert.deepEqual(normalized.errors, []);
  assert.equal(normalized.value.availability, "out");

  const { availability: _availability, ...legacyDish } = frontendDish;
  const legacy = validateDishPayload(legacyDish);
  assert.deepEqual(legacy.errors, []);
  assert.equal(legacy.value.availability, "available");

  for (const availability of [null, "", "sold-out", true]) {
    const result = validateDishPayload({ ...frontendDish, availability });
    assert.ok(
      result.errors.some(({ field }) => field === "availability"),
      String(availability),
    );
  }
});

test("validates and normalizes allergen and private RAG metadata", () => {
  const valid = validateDishPayload({
    ...frontendDish,
    allergens: [
      "sesame",
      "soy",
      "wheat",
      "tree-nuts",
      "peanut",
      "egg",
      "milk",
      "shellfish",
      "fish",
    ],
    fullDishInfo: "  Best paired with the house ponzu.  ",
  });

  assert.deepEqual(valid.errors, []);
  assert.deepEqual(ALLERGEN_TYPES, [
    "fish",
    "shellfish",
    "milk",
    "egg",
    "peanut",
    "tree-nuts",
    "wheat",
    "soy",
    "sesame",
  ]);
  assert.deepEqual(valid.value.allergens, ALLERGEN_TYPES);
  assert.equal(valid.value.fullDishInfo, "Best paired with the house ponzu.");

  const legacyGluten = validateDishPayload({
    ...frontendDish,
    allergens: ["soy", "gluten", "wheat", "shellfish"],
  });
  assert.deepEqual(legacyGluten.errors, []);
  assert.deepEqual(legacyGluten.value.allergens, [
    "shellfish",
    "wheat",
    "soy",
  ]);

  const legacy = validateDishPayload(frontendDish);
  assert.ok(!Object.hasOwn(legacy.value, "allergens"));
  assert.ok(!Object.hasOwn(legacy.value, "fullDishInfo"));

  for (const allergens of [
    "shellfish",
    ["unknown"],
    ["peanut", "peanut"],
    ["gluten", 4],
  ]) {
    const result = validateDishPayload({ ...frontendDish, allergens });
    assert.ok(
      result.errors.some(({ field }) => field.startsWith("allergens")),
      JSON.stringify(allergens),
    );
  }

  for (const fullDishInfo of [42, "x".repeat(4001)]) {
    const result = validateDishPayload({ ...frontendDish, fullDishInfo });
    assert.ok(result.errors.some(({ field }) => field === "fullDishInfo"));
  }
});

test("stores only canonical allergens when creating a dish", async () => {
  const { handler, calls } = buildHandler();
  const response = await handler(
    eventFor({
      ...frontendDish,
      allergens: ["soy", "gluten", "wheat", "fish"],
    }),
  );
  const expectedAllergens = ["fish", "wheat", "soy"];

  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls[0].Item.allergens, expectedAllergens);
  assert.deepEqual(responseBody(response).allergens, expectedAllergens);
});

test("validates optional image metadata and keeps legacy dishes valid", () => {
  const valid = validateDishPayload({
    ...frontendDish,
    image: { ...frontendDishImage, alt: "  " },
  });

  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.value.image, {
    ...frontendDishImage,
    alt: "",
  });

  const normalizedId = validateDishPayload({
    ...frontendDish,
    id: "  sora-roll  ",
    image: frontendDishImage,
  });
  assert.deepEqual(normalizedId.errors, []);
  assert.equal(normalizedId.value.id, "sora-roll");

  const legacy = validateDishPayload(frontendDish);
  assert.deepEqual(legacy.errors, []);
  assert.ok(!Object.hasOwn(legacy.value, "image"));

  const invalidCases = [
    { image: null, field: "image" },
    { image: [], field: "image" },
    {
      image: { ...frontendDishImage, key: "dishes/akami/photo.webp" },
      field: "image.key",
    },
    {
      image: { ...frontendDishImage, key: "dishes/sora-roll/../photo.webp" },
      field: "image.key",
    },
    {
      image: { ...frontendDishImage, key: "dishes/sora-roll/photo.gif" },
      field: "image.key",
    },
    {
      image: { ...frontendDishImage, alt: "x".repeat(251) },
      field: "image.alt",
    },
    {
      image: { ...frontendDishImage, width: 0 },
      field: "image.width",
    },
    {
      image: { ...frontendDishImage, width: 10_001 },
      field: "image.width",
    },
    {
      image: { ...frontendDishImage, height: 1.5 },
      field: "image.height",
    },
    {
      image: { ...frontendDishImage, width: "800" },
      field: "image.width",
    },
    {
      image: { ...frontendDishImage, url: "https://example.com/image.webp" },
      field: "image.url",
    },
  ];

  for (const { image, field } of invalidCases) {
    const result = validateDishPayload({ ...frontendDish, image });
    assert.ok(
      result.errors.some((error) => error.field === field),
      `${field}: ${JSON.stringify(image)}`,
    );
  }
});

test("requires every image field and accepts image dimension boundaries", () => {
  const boundary = validateDishPayload({
    ...frontendDish,
    image: {
      ...frontendDishImage,
      width: 1,
      height: 10_000,
    },
  });
  assert.deepEqual(boundary.errors, []);

  for (const field of ["key", "alt", "width", "height"]) {
    const image = { ...frontendDishImage };
    delete image[field];
    const result = validateDishPayload({ ...frontendDish, image });
    assert.ok(
      result.errors.some((error) => error.field === `image.${field}`),
      field,
    );
  }
});

test("returns a sanitized error when DynamoDB fails", async () => {
  const documentClient = {
    async send() {
      const error = new Error("secret AWS failure details");
      error.name = "ProvisionedThroughputExceededException";
      throw error;
    },
  };
  const { handler } = buildHandler({ documentClient });
  const response = await handler(eventFor(frontendDish));

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
  assert.ok(!response.body.includes("secret AWS failure details"));
});

test("returns a sanitized error when the table is not configured", async () => {
  const { handler } = buildHandler({ tableName: "" });
  const response = await handler(eventFor(frontendDish));

  assert.equal(response.statusCode, 500);
  assert.equal(responseBody(response).error.code, "INTERNAL_ERROR");
});
