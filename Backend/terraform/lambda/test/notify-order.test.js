"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createNotifyOrderHandler,
  createOrderEmail,
  parseOrderCreatedMessage,
} = require("../handler/notify-order");

class FakeGetCommand {
  constructor(input) {
    this.input = input;
  }
}

class FakeUpdateCommand {
  constructor(input) {
    this.input = input;
  }
}

class FakeSendEmailCommand {
  constructor(input) {
    this.input = input;
  }
}

const fixedNow = new Date("2026-07-22T20:30:00.000Z");
const baseOrder = {
  orderId: "ord_123",
  customerId: "customer-sub",
  clientRequestId: "client-request-123",
  status: "PENDING",
  notificationStatus: "PENDING",
  fulfillment: "PICKUP",
  pickupContact: {
    name: "Sithu <script>alert(1)</script>",
    phoneNumber: "+14155552671",
  },
  items: [
    {
      dishId: "sora-roll",
      name: "Sora & house roll",
      quantity: 2,
      unitPriceCents: 2400,
      lineTotalCents: 4800,
    },
  ],
  subtotalCents: 4800,
  customerNote: "Please call <b>once</b>.\nNo utensils.",
  createdAt: "2026-07-22T20:15:00.000Z",
};

const sqsRecord = (
  messageId,
  payload = {
    eventType: "ORDER_CREATED",
    version: 1,
    orderId: "ord_123",
  },
) => ({
  messageId,
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
});

const buildHandler = (overrides = {}) => {
  const documentCalls = [];
  const sesCalls = [];
  const logs = [];
  const order = overrides.order === undefined ? baseOrder : overrides.order;
  const documentClient = {
    async send(command) {
      documentCalls.push(command);

      if (command instanceof FakeGetCommand) {
        if (overrides.getError) {
          throw overrides.getError;
        }
        return order ? { Item: order } : {};
      }

      if (command instanceof FakeUpdateCommand) {
        if (overrides.updateError) {
          throw overrides.updateError;
        }
        return {};
      }

      throw new Error("Unexpected DynamoDB command");
    },
  };
  const sesClient = {
    async send(command) {
      sesCalls.push(command);
      if (overrides.sesError) {
        throw overrides.sesError;
      }
      return { MessageId: "ses-message-123" };
    },
  };
  const handler = createNotifyOrderHandler({
    tableName: "orders-test",
    fromEmail: "orders@example.com",
    adminEmail: "admin@example.com",
    documentClient,
    sesClient,
    GetCommand: FakeGetCommand,
    UpdateCommand: FakeUpdateCommand,
    SendEmailCommand: FakeSendEmailCommand,
    now: () => fixedNow,
    logger: {
      error(message, metadata) {
        logs.push({ message, metadata });
      },
    },
    ...overrides.dependencies,
  });

  return { handler, documentCalls, sesCalls, logs };
};

test("loads an order, sends plain-text and escaped HTML, then marks the notification SENT", async () => {
  const { handler, documentCalls, sesCalls } = buildHandler();

  const result = await handler({
    Records: [sqsRecord("message-1")],
  });

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(documentCalls.length, 2);
  assert.ok(documentCalls[0] instanceof FakeGetCommand);
  assert.deepEqual(documentCalls[0].input, {
    TableName: "orders-test",
    Key: { orderId: "ord_123" },
    ConsistentRead: true,
  });

  assert.equal(sesCalls.length, 1);
  const emailInput = sesCalls[0].input;
  assert.deepEqual(emailInput.Destination, {
    ToAddresses: ["admin@example.com"],
  });
  assert.equal(emailInput.FromEmailAddress, "orders@example.com");
  assert.equal(
    emailInput.Content.Simple.Subject.Data,
    "New pickup order ord_123",
  );
  assert.match(emailInput.Content.Simple.Body.Text.Data, /Sora & house roll/u);
  assert.match(emailInput.Content.Simple.Body.Text.Data, /\$48\.00/u);
  assert.match(
    emailInput.Content.Simple.Body.Html.Data,
    /Sithu &lt;script&gt;alert\(1\)&lt;\/script&gt;/u,
  );
  assert.match(
    emailInput.Content.Simple.Body.Html.Data,
    /Sora &amp; house roll/u,
  );
  assert.doesNotMatch(
    emailInput.Content.Simple.Body.Html.Data,
    /<script>/u,
  );
  assert.match(
    emailInput.Content.Simple.Body.Html.Data,
    /Please call &lt;b&gt;once&lt;\/b&gt;\.<br>No utensils\./u,
  );

  assert.ok(documentCalls[1] instanceof FakeUpdateCommand);
  assert.deepEqual(documentCalls[1].input, {
    TableName: "orders-test",
    Key: { orderId: "ord_123" },
    UpdateExpression:
      "SET #notificationStatus = :sent, #notificationSentAt = :sentAt, #notificationMessageId = :messageId",
    ConditionExpression:
      "attribute_not_exists(#notificationStatus) OR #notificationStatus <> :sent",
    ExpressionAttributeNames: {
      "#notificationStatus": "notificationStatus",
      "#notificationSentAt": "notificationSentAt",
      "#notificationMessageId": "notificationMessageId",
    },
    ExpressionAttributeValues: {
      ":sent": "SENT",
      ":sentAt": fixedNow.toISOString(),
      ":messageId": "ses-message-123",
    },
  });
  assert.equal(
    Object.values(documentCalls[1].input.ExpressionAttributeNames).includes(
      "status",
    ),
    false,
  );
});

test("skips duplicate messages when the notification is already SENT, ignoring case", async () => {
  for (const notificationStatus of ["SENT", "sent", " Sent "]) {
    const { handler, documentCalls, sesCalls } = buildHandler({
      order: { ...baseOrder, notificationStatus },
    });

    const result = await handler({
      Records: [sqsRecord(`message-${notificationStatus}`)],
    });

    assert.deepEqual(result, { batchItemFailures: [] });
    assert.equal(documentCalls.length, 1);
    assert.equal(sesCalls.length, 0);
  }
});

test("returns only failed record IDs so successful messages are removed from SQS", async () => {
  const { handler, documentCalls, sesCalls, logs } = buildHandler();

  const result = await handler({
    Records: [
      sqsRecord("bad-message", "{not-json"),
      sqsRecord("good-message"),
    ],
  });

  assert.deepEqual(result, {
    batchItemFailures: [{ itemIdentifier: "bad-message" }],
  });
  assert.equal(documentCalls.length, 2);
  assert.equal(sesCalls.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].metadata.messageId, "bad-message");
  assert.equal(JSON.stringify(logs).includes(baseOrder.pickupContact.name), false);
  assert.equal(
    JSON.stringify(logs).includes(baseOrder.pickupContact.phoneNumber),
    false,
  );
  assert.equal(JSON.stringify(logs).includes(baseOrder.customerNote), false);
});

test("leaves a record for retry when SES fails and does not update DynamoDB", async () => {
  const { handler, documentCalls, sesCalls, logs } = buildHandler({
    sesError: new Error("SES rejected private customer content"),
  });

  const result = await handler({
    Records: [sqsRecord("message-1")],
  });

  assert.deepEqual(result, {
    batchItemFailures: [{ itemIdentifier: "message-1" }],
  });
  assert.equal(documentCalls.length, 1);
  assert.equal(sesCalls.length, 1);
  assert.equal(
    JSON.stringify(logs).includes("private customer content"),
    false,
  );
});

test("leaves missing orders for retry and never calls SES", async () => {
  const { handler, documentCalls, sesCalls } = buildHandler({ order: null });

  const result = await handler({
    Records: [sqsRecord("message-1")],
  });

  assert.deepEqual(result, {
    batchItemFailures: [{ itemIdentifier: "message-1" }],
  });
  assert.equal(documentCalls.length, 1);
  assert.equal(sesCalls.length, 0);
});

test("accepts an EventBridge detail wrapper and a raw DynamoDB INSERT envelope", () => {
  assert.deepEqual(
    parseOrderCreatedMessage(
      JSON.stringify({
        detail: {
          eventType: "ORDER_CREATED",
          version: 1,
          orderId: "ord_detail",
        },
      }),
    ),
    {
      eventType: "ORDER_CREATED",
      version: 1,
      orderId: "ord_detail",
    },
  );

  assert.deepEqual(
    parseOrderCreatedMessage(
      JSON.stringify({
        eventName: "INSERT",
        dynamodb: {
          NewImage: {
            orderId: { S: "ord_stream" },
          },
        },
      }),
    ),
    {
      eventType: "ORDER_CREATED",
      version: 1,
      orderId: "ord_stream",
    },
  );
});

test("rejects unsupported versions, event types, and unsafe order IDs", () => {
  for (const payload of [
    { eventType: "ORDER_UPDATED", version: 1, orderId: "ord_123" },
    { eventType: "ORDER_CREATED", version: 2, orderId: "ord_123" },
    { eventType: "ORDER_CREATED", version: 1, orderId: "bad\nsubject" },
    { eventType: "ORDER_CREATED", version: 1, orderId: "" },
  ]) {
    assert.throws(
      () => parseOrderCreatedMessage(JSON.stringify(payload)),
      { name: "OrderNotificationError" },
      JSON.stringify(payload),
    );
  }
});

test("treats a concurrent SENT update as success after SES accepts the email", async () => {
  const updateError = new Error("condition failed");
  updateError.name = "ConditionalCheckFailedException";
  const { handler, documentCalls, sesCalls } = buildHandler({ updateError });

  const result = await handler({
    Records: [sqsRecord("message-1")],
  });

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(documentCalls.length, 2);
  assert.equal(sesCalls.length, 1);
});

test("creates a useful email when the stored subtotal and line total are omitted", () => {
  const email = createOrderEmail({
    ...baseOrder,
    subtotalCents: undefined,
    items: [
      {
        dishId: "akami",
        name: "Akami",
        quantity: 3,
        unitPriceCents: 1400,
      },
    ],
  });

  assert.match(email.text, /3 x Akami — \$42\.00/u);
  assert.match(email.text, /Subtotal: \$42\.00/u);
});

test("returns an empty failure list for an event without records", async () => {
  const { handler, documentCalls, sesCalls } = buildHandler();

  assert.deepEqual(await handler(null), { batchItemFailures: [] });
  assert.equal(documentCalls.length, 0);
  assert.equal(sesCalls.length, 0);
});
