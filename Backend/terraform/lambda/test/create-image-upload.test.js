"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  IMAGE_CACHE_CONTROL,
  MAX_BODY_BYTES,
  MAX_IMAGE_BYTES,
  createImageUploadHandler,
} = require("../handler/create-image-upload");

const fixedUuid = "550e8400-e29b-41d4-a716-446655440000";
const silentLogger = { error() {} };

const eventFor = (
  body,
  claims = { sub: "user-123", "cognito:groups": "admin" },
) => ({
  body: typeof body === "string" ? body : JSON.stringify(body),
  requestContext: { authorizer: { claims } },
});

const responseBody = (response) => JSON.parse(response.body);

const buildHandler = (overrides = {}) => {
  const calls = [];
  const s3Client = overrides.s3Client || { name: "fake-s3-client" };

  class FakePutObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }

  const getSignedUrl =
    overrides.getSignedUrl ||
    (async (client, command, options) => {
      calls.push({ client, input: command.input, options });
      return "https://images.example/upload?signature=test";
    });

  return {
    calls,
    s3Client,
    handler: createImageUploadHandler({
      bucketName: "dish-images-test",
      allowedOrigin: "https://sushi.example",
      adminGroupName: "admin",
      s3Client,
      PutObjectCommand: FakePutObjectCommand,
      getSignedUrl,
      randomUUID: () => fixedUuid,
      logger: silentLogger,
      ...overrides,
    }),
  };
};

test("creates a five-minute presigned PutObject URL with an immutable server key", async () => {
  const { handler, calls, s3Client } = buildHandler();

  const response = await handler(
    eventFor({
      dishId: "sora-roll",
      contentType: "image/jpeg",
      size: 125000,
    }),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.equal(
    response.headers["Access-Control-Allow-Headers"],
    "Content-Type,Authorization",
  );
  assert.deepEqual(calls, [
    {
      client: s3Client,
      input: {
        Bucket: "dish-images-test",
        Key: `dishes/sora-roll/${fixedUuid}.jpg`,
        ContentType: "image/jpeg",
        CacheControl: IMAGE_CACHE_CONTROL,
      },
      options: {
        expiresIn: 300,
        signableHeaders: new Set(["cache-control", "content-type"]),
      },
    },
  ]);
  assert.deepEqual(responseBody(response), {
    uploadUrl: "https://images.example/upload?signature=test",
    key: `dishes/sora-roll/${fixedUuid}.jpg`,
    expiresIn: 300,
    uploadHeaders: {
      "Cache-Control": IMAGE_CACHE_CONTROL,
      "Content-Type": "image/jpeg",
    },
  });
});

test("maps each supported image content type to its key extension", async () => {
  for (const [contentType, extension] of [
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ]) {
    const { handler, calls } = buildHandler();
    const response = await handler(
      eventFor({ dishId: "akami", contentType, size: MAX_IMAGE_BYTES }),
    );

    assert.equal(response.statusCode, 200, contentType);
    assert.equal(calls[0].input.ContentType, contentType);
    assert.equal(calls[0].input.Key, `dishes/akami/${fixedUuid}.${extension}`);
  }
});

test("requires a Cognito identity and the configured admin group", async () => {
  const { handler, calls } = buildHandler();
  const request = {
    dishId: "akami",
    contentType: "image/png",
    size: 100,
  };

  const unauthenticated = await handler(eventFor(request, {}));
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(responseBody(unauthenticated).error.code, "UNAUTHORIZED");

  const notAdmin = await handler(
    eventFor(request, {
      sub: "user-123",
      "cognito:groups": "customers,editors",
    }),
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
    const event = eventFor({
      dishId: "akami",
      contentType: "image/webp",
      size: 100,
    });
    event.requestContext.authorizer = {
      jwt: { claims: { sub: "user-123", "cognito:groups": groups } },
    };

    const response = await handler(event);
    assert.equal(response.statusCode, 200, JSON.stringify(groups));
  }
});

test("accepts a base64-encoded JSON request body", async () => {
  const { handler, calls } = buildHandler();
  const event = eventFor({
    dishId: " akami ",
    contentType: "image/png",
    size: 512,
  });
  event.body = Buffer.from(event.body, "utf8").toString("base64");
  event.isBase64Encoded = true;

  const response = await handler(event);

  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].input.Key, `dishes/akami/${fixedUuid}.png`);
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

  const oversized = await handler(eventFor("x".repeat(MAX_BODY_BYTES + 1)));
  assert.equal(oversized.statusCode, 413);
  assert.equal(responseBody(oversized).error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(calls.length, 0);
});

test("requires exactly dishId, contentType, and size", async () => {
  const { handler, calls } = buildHandler();

  for (const body of [
    [],
    {},
    { dishId: "akami", contentType: "image/png" },
    {
      dishId: "akami",
      contentType: "image/png",
      size: 512,
      fileName: "akami.png",
    },
  ]) {
    const response = await handler(eventFor(body));
    assert.equal(response.statusCode, 422, JSON.stringify(body));
    assert.equal(responseBody(response).error.code, "VALIDATION_ERROR");
  }

  const unknownField = await handler(
    eventFor({
      dishId: "akami",
      contentType: "image/png",
      size: 512,
      fileName: "akami.png",
    }),
  );
  assert.ok(
    responseBody(unknownField).error.details.some(
      ({ field }) => field === "fileName",
    ),
  );
  assert.equal(calls.length, 0);
});

test("validates dish ids, image types, and declared image sizes", async () => {
  const invalidRequests = [
    { dishId: "bad/id", contentType: "image/png", size: 100 },
    { dishId: "akami", contentType: "image/gif", size: 100 },
    { dishId: "akami", contentType: "IMAGE/PNG", size: 100 },
    { dishId: "akami", contentType: "image/png", size: 0 },
    { dishId: "akami", contentType: "image/png", size: 1.5 },
    { dishId: "akami", contentType: "image/png", size: "100" },
    {
      dishId: "akami",
      contentType: "image/png",
      size: MAX_IMAGE_BYTES + 1,
    },
  ];

  for (const request of invalidRequests) {
    const { handler, calls } = buildHandler();
    const response = await handler(eventFor(request));
    assert.equal(response.statusCode, 422, JSON.stringify(request));
    assert.equal(responseBody(response).error.code, "VALIDATION_ERROR");
    assert.equal(calls.length, 0);
  }
});

test("returns CORS-enabled sanitized errors for missing config and signer failures", async () => {
  const request = {
    dishId: "akami",
    contentType: "image/png",
    size: 100,
  };
  const missingConfig = buildHandler({ bucketName: "" });
  const missingConfigResponse = await missingConfig.handler(eventFor(request));

  assert.equal(missingConfigResponse.statusCode, 500);
  assert.equal(
    missingConfigResponse.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.equal(
    responseBody(missingConfigResponse).error.code,
    "INTERNAL_ERROR",
  );
  assert.equal(missingConfig.calls.length, 0);

  const signingFailure = buildHandler({
    async getSignedUrl() {
      throw new Error("secret AWS signing failure");
    },
  });
  const signingFailureResponse = await signingFailure.handler(eventFor(request));

  assert.equal(signingFailureResponse.statusCode, 500);
  assert.equal(
    signingFailureResponse.headers["Access-Control-Allow-Origin"],
    "https://sushi.example",
  );
  assert.equal(responseBody(signingFailureResponse).error.code, "INTERNAL_ERROR");
  assert.ok(!signingFailureResponse.body.includes("secret AWS signing failure"));
});
