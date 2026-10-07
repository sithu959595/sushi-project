"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCustomerStatusEmail,
  createNotifyCustomerStatusHandler,
  parseStatusChangedMessage,
} = require("../handler/notify-customer-status");

class FakeGetCommand {
  constructor(input) {
    this.input = input;
  }
}

class FakeSendEmailCommand {
  constructor(input) {
    this.input = input;
  }
}

const ORDER_ID = "ord_550e8400-e29b-41d4-a716-446655440001";
const CHANGED_AT = "2026-07-29T02:30:00.000Z";
const PICKUP_TIME = "2026-07-29T03:00:00.000Z";
const FAILED_AT = CHANGED_AT;
const EVENT_ID = "9b341aa3-91d2-4aea-a7fc:123";

const eventFor = (
  status = "CONFIRMED",
  previousStatus = "PENDING",
  overrides = {},
) => ({
  eventType: "ORDER_STATUS_CHANGED",
  version: 1,
  eventId: EVENT_ID,
  orderId: ORDER_ID,
  previousStatus,
  status,
  changedAt: CHANGED_AT,
  ...overrides,
});

const recordFor = (
  messageId,
  payload = eventFor(),
) => ({
  messageId,
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
});

const orderFor = (orderEvent = eventFor(), overrides = {}) => ({
  orderId: ORDER_ID,
  entityType: "ORDER",
  status: orderEvent.status,
  statusUpdatedAt: orderEvent.changedAt,
  customerEmail: "customer@example.com",
  pickupContact: {
    name: "Sithu & <Customer>",
    phoneNumber: "+14155552671",
  },
  items: [
    {
      dishId: "sora-roll",
      name: "Sora Roll",
      quantity: 1,
      lineTotalCents: 2400,
    },
  ],
  restaurantNote: "Please arrive at the counter.\nAsk for <Sam>.",
  ...(orderEvent.status === "CONFIRMED"
    ? { pickupTime: PICKUP_TIME }
    : {}),
  ...(orderEvent.status === "FAILED_TO_PICKUP"
    ? {
        scheduledPickupTime: PICKUP_TIME,
        failedToPickupAt: FAILED_AT,
      }
    : {}),
  ...overrides,
});

const buildHandler = (overrides = {}) => {
  const documentCalls = [];
  const sesCalls = [];
  const logs = [];
  let getIndex = 0;
  const documentClient = {
    async send(command) {
      documentCalls.push(command);
      if (!(command instanceof FakeGetCommand)) {
        throw new Error("Unexpected DynamoDB command");
      }
      if (overrides.getError) {
        throw overrides.getError;
      }

      const configuredOrder =
        typeof overrides.order === "function"
          ? overrides.order(getIndex)
          : overrides.order;
      getIndex += 1;
      if (configuredOrder === null) {
        return {};
      }

      return {
        Item:
          configuredOrder === undefined
            ? orderFor(overrides.orderEvent || eventFor())
            : configuredOrder,
      };
    },
  };
  const sesClient = {
    async send(command) {
      sesCalls.push(command);
      if (overrides.sesError) {
        throw overrides.sesError;
      }
      return { MessageId: `ses-${sesCalls.length}` };
    },
  };
  const handler = createNotifyCustomerStatusHandler({
    tableName:
      overrides.tableName === undefined
        ? "orders-test"
        : overrides.tableName,
    fromEmail:
      overrides.fromEmail === undefined
        ? "orders@example.com"
        : overrides.fromEmail,
    documentClient,
    sesClient,
    GetCommand: FakeGetCommand,
    SendEmailCommand: FakeSendEmailCommand,
    logger: {
      error(message, metadata) {
        logs.push({ message, metadata });
      },
    },
  });

  return { handler, documentCalls, sesCalls, logs };
};

test("parses the exact versioned status-change message", () => {
  const payload = eventFor();
  assert.deepEqual(
    parseStatusChangedMessage(JSON.stringify(payload)),
    payload,
  );
});

test("sends a confirmation email to the stored customer address", async () => {
  const orderEvent = eventFor("CONFIRMED", "PENDING");
  const { handler, documentCalls, sesCalls } = buildHandler({
    orderEvent,
  });

  const result = await handler({
    Records: [recordFor("message-confirmed", orderEvent)],
  });

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(documentCalls.length, 1);
  assert.ok(documentCalls[0] instanceof FakeGetCommand);
  assert.deepEqual(documentCalls[0].input, {
    TableName: "orders-test",
    Key: { orderId: ORDER_ID },
    ConsistentRead: true,
  });
  assert.equal(sesCalls.length, 1);
  assert.deepEqual(sesCalls[0].input.Destination, {
    ToAddresses: ["customer@example.com"],
  });
  assert.equal(
    sesCalls[0].input.Content.Simple.Subject.Data,
    "Your pickup order is confirmed",
  );
  assert.match(
    sesCalls[0].input.Content.Simple.Body.Text.Data,
    new RegExp(`Pickup time: ${PICKUP_TIME}`, "u"),
  );
  assert.equal(sesCalls[0].input.FromEmailAddress, "orders@example.com");
});

test("creates a customer-facing template for every supported target status", () => {
  const cases = [
    {
      status: "CONFIRMED",
      previousStatus: "PENDING",
      subject: "Your pickup order is confirmed",
      text: "has been confirmed",
    },
    {
      status: "CANCELLED",
      previousStatus: "PENDING",
      subject: "Your pickup order was cancelled",
      text: "has been cancelled",
    },
    {
      status: "REJECTED",
      previousStatus: "PENDING",
      subject: "We could not accept your pickup order",
      text: "could not accept",
    },
    {
      status: "FAILED_TO_PICKUP",
      previousStatus: "CONFIRMED",
      subject: "Your order was marked as not picked up",
      text: "marked as not picked up",
    },
  ];

  for (const templateCase of cases) {
    const orderEvent = eventFor(
      templateCase.status,
      templateCase.previousStatus,
    );
    const email = createCustomerStatusEmail(
      orderFor(orderEvent),
      orderEvent,
    );

    assert.equal(email.subject, templateCase.subject);
    assert.match(email.text, new RegExp(templateCase.text, "u"));
    assert.match(email.text, new RegExp(`Order ID: ${ORDER_ID}`, "u"));
    assert.match(email.text, /Message from the restaurant:/u);
    assert.match(email.html, /Message from the restaurant/u);
  }
});

test("failed-pickup email includes both authoritative timestamps", async () => {
  const orderEvent = eventFor(
    "FAILED_TO_PICKUP",
    "CONFIRMED",
  );
  const { handler, sesCalls } = buildHandler({
    orderEvent,
  });

  const result = await handler({
    Records: [recordFor("message-failed-pickup", orderEvent)],
  });

  assert.deepEqual(result, { batchItemFailures: [] });
  const textBody = sesCalls[0].input.Content.Simple.Body.Text.Data;
  assert.match(
    textBody,
    new RegExp(`Scheduled pickup time: ${PICKUP_TIME}`, "u"),
  );
  assert.match(
    textBody,
    new RegExp(`Marked as not picked up: ${FAILED_AT}`, "u"),
  );
});

test("escapes stored customer content in HTML while preserving plain text", () => {
  const orderEvent = eventFor();
  const email = createCustomerStatusEmail(
    orderFor(orderEvent),
    orderEvent,
  );

  assert.match(email.text, /Sithu & <Customer>/u);
  assert.match(email.text, /Ask for <Sam>\./u);
  assert.match(email.html, /Sithu &amp; &lt;Customer&gt;/u);
  assert.match(email.html, /Ask for &lt;Sam&gt;\./u);
  assert.match(email.html, /counter\.<br>Ask/u);
  assert.doesNotMatch(email.html, /<Customer>|<Sam>/u);
});

test("same-status records are successful no-ops before configuration and DynamoDB", async () => {
  const sameStatusEvent = eventFor("CONFIRMED", "CONFIRMED");
  const { handler, documentCalls, sesCalls } = buildHandler({
    tableName: "",
    fromEmail: "",
  });

  const result = await handler({
    Records: [recordFor("same-status", sameStatusEvent)],
  });

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(documentCalls.length, 0);
  assert.equal(sesCalls.length, 0);
});

test("stale and out-of-order records complete without sending email", async () => {
  const orderEvent = eventFor("CONFIRMED", "PENDING");

  for (const order of [
    orderFor(orderEvent, { status: "CANCELLED" }),
    orderFor(orderEvent, {
      statusUpdatedAt: "2026-07-29T02:31:00.000Z",
    }),
  ]) {
    const { handler, documentCalls, sesCalls } = buildHandler({ order });
    const result = await handler({
      Records: [recordFor("stale-message", orderEvent)],
    });

    assert.deepEqual(result, { batchItemFailures: [] });
    assert.equal(documentCalls.length, 1);
    assert.equal(sesCalls.length, 0);
  }
});

test("acknowledges a stale legacy order without a customer email", async () => {
  const orderEvent = eventFor("CONFIRMED", "PENDING");
  const { handler, documentCalls, sesCalls } = buildHandler({
    order: orderFor(orderEvent, {
      status: "CANCELLED",
      statusUpdatedAt: "2026-07-29T02:31:00.000Z",
      customerEmail: undefined,
    }),
  });

  const result = await handler({
    Records: [recordFor("stale-legacy-order", orderEvent)],
  });

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(documentCalls.length, 1);
  assert.equal(sesCalls.length, 0);
});

test("duplicate deliveries are allowed to send duplicate emails", async () => {
  const orderEvent = eventFor();
  const { handler, documentCalls, sesCalls } = buildHandler({
    orderEvent,
  });

  const result = await handler({
    Records: [
      recordFor("duplicate-1", orderEvent),
      recordFor("duplicate-2", orderEvent),
    ],
  });

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(documentCalls.length, 2);
  assert.equal(sesCalls.length, 2);
});

test("rejects malformed or unsupported messages before DynamoDB", async (t) => {
  const valid = eventFor();
  const invalidMessages = [
    ["non-JSON", "{not-json"],
    ["non-object", JSON.stringify([])],
    ["missing field", JSON.stringify({ ...valid, eventId: undefined })],
    ["extra field", JSON.stringify({ ...valid, customerEmail: "x@y.z" })],
    [
      "wrong event type",
      JSON.stringify({ ...valid, eventType: "ORDER_CREATED" }),
    ],
    ["wrong version", JSON.stringify({ ...valid, version: 2 })],
    ["unsafe event ID", JSON.stringify({ ...valid, eventId: "bad id" })],
    ["long event ID", JSON.stringify({ ...valid, eventId: "a".repeat(257) })],
    ["invalid order ID", JSON.stringify({ ...valid, orderId: "ord_123" })],
    [
      "unknown previous status",
      JSON.stringify({ ...valid, previousStatus: "READY" }),
    ],
    ["unsupported target", JSON.stringify({ ...valid, status: "PICKED_UP" })],
    [
      "invalid transition",
      JSON.stringify({
        ...valid,
        previousStatus: "REJECTED",
        status: "CONFIRMED",
      }),
    ],
    [
      "noncanonical timestamp",
      JSON.stringify({
        ...valid,
        changedAt: "2026-07-28T19:30:00.000-07:00",
      }),
    ],
    [
      "impossible timestamp",
      JSON.stringify({ ...valid, changedAt: "2026-02-30T00:00:00.000Z" }),
    ],
    ["oversized body", "x".repeat(8 * 1024 + 1)],
  ];

  for (const [name, body] of invalidMessages) {
    await t.test(name, async () => {
      const { handler, documentCalls, sesCalls } = buildHandler();
      const result = await handler({
        Records: [recordFor(`bad-${name}`, body)],
      });

      assert.deepEqual(result, {
        batchItemFailures: [{ itemIdentifier: `bad-${name}` }],
      });
      assert.equal(documentCalls.length, 0);
      assert.equal(sesCalls.length, 0);
    });
  }
});

test("reports missing configuration as a failed SQS record", async () => {
  for (const config of [
    { tableName: "" },
    { fromEmail: "" },
    { fromEmail: "not-an-email" },
  ]) {
    const { handler, documentCalls, sesCalls } = buildHandler(config);
    const result = await handler({
      Records: [recordFor("missing-config")],
    });

    assert.deepEqual(result, {
      batchItemFailures: [{ itemIdentifier: "missing-config" }],
    });
    assert.equal(documentCalls.length, 0);
    assert.equal(sesCalls.length, 0);
  }
});

test("rejects missing or invalid stored orders and customer email", async () => {
  const invalidOrders = [
    null,
    orderFor(eventFor(), { entityType: "IDEMPOTENCY" }),
    orderFor(eventFor(), { orderId: `${ORDER_ID}-different` }),
    orderFor(eventFor(), { customerEmail: undefined }),
    orderFor(eventFor(), { customerEmail: "not-an-email" }),
    orderFor(eventFor(), { customerEmail: "victim@example.com\r\nBcc:x@y.z" }),
  ];

  for (const order of invalidOrders) {
    const { handler, documentCalls, sesCalls } = buildHandler({ order });
    const result = await handler({
      Records: [recordFor("invalid-order")],
    });

    assert.deepEqual(result, {
      batchItemFailures: [{ itemIdentifier: "invalid-order" }],
    });
    assert.equal(documentCalls.length, 1);
    assert.equal(sesCalls.length, 0);
  }
});

test("requires status-specific stored pickup details", async () => {
  const cases = [
    {
      event: eventFor("CONFIRMED", "PENDING"),
      order: orderFor(eventFor("CONFIRMED", "PENDING"), {
        pickupTime: undefined,
      }),
    },
    {
      event: eventFor("CONFIRMED", "PENDING"),
      order: orderFor(eventFor("CONFIRMED", "PENDING"), {
        pickupTime: "2026-07-28T20:00:00.000-07:00",
      }),
    },
    {
      event: eventFor("FAILED_TO_PICKUP", "CONFIRMED"),
      order: orderFor(eventFor("FAILED_TO_PICKUP", "CONFIRMED"), {
        scheduledPickupTime: undefined,
      }),
    },
    {
      event: eventFor("FAILED_TO_PICKUP", "CONFIRMED"),
      order: orderFor(eventFor("FAILED_TO_PICKUP", "CONFIRMED"), {
        failedToPickupAt: undefined,
      }),
    },
  ];

  for (const { event, order } of cases) {
    const { handler, sesCalls } = buildHandler({ order });
    const result = await handler({
      Records: [recordFor("missing-detail", event)],
    });

    assert.deepEqual(result, {
      batchItemFailures: [{ itemIdentifier: "missing-detail" }],
    });
    assert.equal(sesCalls.length, 0);
  }
});

test("DynamoDB and SES errors fail only their SQS records", async () => {
  const getError = Object.assign(new Error("DynamoDB unavailable"), {
    name: "ProvisionedThroughputExceededException",
    $metadata: { requestId: "ddb-request-1" },
  });
  const getFailure = buildHandler({ getError });
  assert.deepEqual(
    await getFailure.handler({
      Records: [recordFor("ddb-failure")],
    }),
    {
      batchItemFailures: [{ itemIdentifier: "ddb-failure" }],
    },
  );
  assert.equal(getFailure.sesCalls.length, 0);

  const sesError = Object.assign(new Error("SES unavailable"), {
    name: "ServiceUnavailableException",
    $metadata: { requestId: "ses-request-1" },
  });
  const sesFailure = buildHandler({ sesError });
  assert.deepEqual(
    await sesFailure.handler({
      Records: [recordFor("ses-failure")],
    }),
    {
      batchItemFailures: [{ itemIdentifier: "ses-failure" }],
    },
  );
  assert.equal(sesFailure.documentCalls.length, 1);
  assert.equal(sesFailure.sesCalls.length, 1);
});

test("continues a mixed batch and returns only failed message IDs", async () => {
  const { handler, documentCalls, sesCalls } = buildHandler();
  const result = await handler({
    Records: [
      recordFor("bad-json", "{"),
      recordFor("good-confirmation", eventFor()),
      recordFor(
        "good-no-op",
        eventFor("CANCELLED", "CANCELLED"),
      ),
    ],
  });

  assert.deepEqual(result, {
    batchItemFailures: [{ itemIdentifier: "bad-json" }],
  });
  assert.equal(documentCalls.length, 1);
  assert.equal(sesCalls.length, 1);
});

test("error logs contain only sanitized operational identifiers", async () => {
  const customerEmail = "private-customer@example.com";
  const restaurantNote = "Private restaurant message";
  const { handler, logs } = buildHandler({
    order: orderFor(eventFor(), { customerEmail, restaurantNote }),
    sesError: Object.assign(new Error("do not log this message"), {
      name: "MessageRejected",
      code: "MessageRejected",
      $metadata: { requestId: "request-123" },
    }),
  });

  await handler({
    Records: [
      recordFor(
        "unsafe message id containing spaces",
        eventFor(),
      ),
    ],
  });

  assert.equal(logs.length, 1);
  assert.equal(
    logs[0].message,
    "Could not send a customer status notification",
  );
  assert.deepEqual(logs[0].metadata, {
    messageId: "unknown",
    errorName: "MessageRejected",
    errorCode: "MessageRejected",
    requestId: "request-123",
  });
  const serializedLog = JSON.stringify(logs);
  assert.doesNotMatch(serializedLog, new RegExp(customerEmail, "u"));
  assert.doesNotMatch(serializedLog, new RegExp(restaurantNote, "u"));
  assert.doesNotMatch(serializedLog, /do not log this message/u);
});

test("an empty invocation succeeds without loading AWS clients", async () => {
  const handler = createNotifyCustomerStatusHandler({
    tableName: "",
    fromEmail: "",
    logger: { error() {} },
  });

  assert.deepEqual(await handler({}), { batchItemFailures: [] });
});
