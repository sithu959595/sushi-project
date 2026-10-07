"use strict";

const ORDER_CREATED_EVENT = "ORDER_CREATED";
const ORDER_EVENT_VERSION = 1;
const MAX_ORDER_ID_LENGTH = 128;

let sharedDynamoDependencies;
let sharedSesDependencies;
let sharedDocumentClient;
let sharedSesClient;

const loadDynamoDependencies = () => {
  if (!sharedDynamoDependencies) {
    const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
    const {
      DynamoDBDocumentClient,
      GetCommand,
      UpdateCommand,
    } = require("@aws-sdk/lib-dynamodb");
    sharedDynamoDependencies = {
      DynamoDBClient,
      DynamoDBDocumentClient,
      GetCommand,
      UpdateCommand,
    };
  }

  return sharedDynamoDependencies;
};

const loadSesDependencies = () => {
  if (!sharedSesDependencies) {
    const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
    sharedSesDependencies = { SESv2Client, SendEmailCommand };
  }

  return sharedSesDependencies;
};

const getDocumentClient = (dependencies) => {
  if (dependencies.documentClient) {
    return dependencies.documentClient;
  }

  if (!sharedDocumentClient) {
    const { DynamoDBClient, DynamoDBDocumentClient } =
      loadDynamoDependencies();
    sharedDocumentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({}),
    );
  }

  return sharedDocumentClient;
};

const getSesClient = (dependencies) => {
  if (dependencies.sesClient) {
    return dependencies.sesClient;
  }

  if (!sharedSesClient) {
    const { SESv2Client } = loadSesDependencies();
    sharedSesClient = new SESv2Client({});
  }

  return sharedSesClient;
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const createProcessingError = (code) => {
  const error = new Error(code);
  error.name = "OrderNotificationError";
  error.code = code;
  return error;
};

const normalizeOrderId = (value) => {
  if (typeof value !== "string") {
    throw createProcessingError("INVALID_ORDER_ID");
  }

  const orderId = value.trim();
  if (
    !orderId ||
    orderId.length > MAX_ORDER_ID_LENGTH ||
    /[\s\u0000-\u001f\u007f]/u.test(orderId)
  ) {
    throw createProcessingError("INVALID_ORDER_ID");
  }

  return orderId;
};

const parseJsonBody = (body) => {
  let value = body;

  for (let attempt = 0; attempt < 2 && typeof value === "string"; attempt += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      throw createProcessingError("INVALID_MESSAGE_JSON");
    }
  }

  if (!isPlainObject(value)) {
    throw createProcessingError("INVALID_MESSAGE");
  }

  return value;
};

const eventFromDynamoEnvelope = (value) => {
  const envelope =
    isPlainObject(value.detail) && value.detail.dynamodb
      ? value.detail
      : value;
  const newImage = envelope?.dynamodb?.NewImage;
  const orderIdAttribute = newImage?.orderId;
  const orderId =
    typeof orderIdAttribute === "string"
      ? orderIdAttribute
      : orderIdAttribute?.S;

  if (envelope?.eventName !== "INSERT" || !orderId) {
    return null;
  }

  return {
    eventType: ORDER_CREATED_EVENT,
    version: ORDER_EVENT_VERSION,
    orderId,
  };
};

const parseOrderCreatedMessage = (body) => {
  const parsed = parseJsonBody(body);
  const payload =
    isPlainObject(parsed.detail) &&
    ("eventType" in parsed.detail || "orderId" in parsed.detail)
      ? parsed.detail
      : eventFromDynamoEnvelope(parsed) || parsed;

  if (
    payload.eventType !== ORDER_CREATED_EVENT ||
    payload.version !== ORDER_EVENT_VERSION
  ) {
    throw createProcessingError("UNSUPPORTED_ORDER_EVENT");
  }

  return {
    eventType: ORDER_CREATED_EVENT,
    version: ORDER_EVENT_VERSION,
    orderId: normalizeOrderId(payload.orderId),
  };
};

const toDisplayText = (value, fallback = "Not provided", maxLength = 2000) => {
  if (value === null || value === undefined) {
    return fallback;
  }

  const text = String(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();

  if (!text) {
    return fallback;
  }

  return text.slice(0, maxLength);
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");

const formatMoney = (value) => {
  const cents = Number(value);
  return Number.isSafeInteger(cents) && cents >= 0
    ? `$${(cents / 100).toFixed(2)}`
    : "Not available";
};

const normalizeOrderItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw createProcessingError("INVALID_STORED_ORDER");
  }

  return items.slice(0, 100).map((item) => {
    if (!isPlainObject(item)) {
      throw createProcessingError("INVALID_STORED_ORDER");
    }

    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw createProcessingError("INVALID_STORED_ORDER");
    }

    const unitPriceCents = Number(item.unitPriceCents);
    const storedLineTotal = Number(item.lineTotalCents);
    const calculatedLineTotal =
      Number.isSafeInteger(unitPriceCents) && unitPriceCents >= 0
        ? unitPriceCents * quantity
        : Number.NaN;
    const lineTotalCents =
      Number.isSafeInteger(storedLineTotal) && storedLineTotal >= 0
        ? storedLineTotal
        : calculatedLineTotal;

    return {
      name: toDisplayText(item.name || item.dishId, "Unnamed dish", 200),
      quantity,
      lineTotalCents,
    };
  });
};

const createOrderEmail = (order) => {
  if (!isPlainObject(order)) {
    throw createProcessingError("INVALID_STORED_ORDER");
  }

  const orderId = normalizeOrderId(order.orderId);
  const items = normalizeOrderItems(order.items);
  const pickupContact = isPlainObject(order.pickupContact)
    ? order.pickupContact
    : {};
  const customerName = toDisplayText(pickupContact.name, "Not provided", 200);
  const phoneNumber = toDisplayText(
    pickupContact.phoneNumber,
    "Not provided",
    100,
  );
  const createdAt = toDisplayText(order.createdAt, "Not available", 100);
  const status = toDisplayText(order.status, "PENDING", 50);
  const customerNote = toDisplayText(
    order.customerNote ?? order.note,
    "None",
    2000,
  );
  const calculatedSubtotal = items.reduce(
    (total, item) =>
      Number.isSafeInteger(item.lineTotalCents)
        ? total + item.lineTotalCents
        : total,
    0,
  );
  const subtotalCents =
    Number.isSafeInteger(Number(order.subtotalCents)) &&
    Number(order.subtotalCents) >= 0
      ? Number(order.subtotalCents)
      : calculatedSubtotal;
  const subtotal = formatMoney(subtotalCents);
  const plainItemLines = items.map(
    (item) =>
      `- ${item.quantity} x ${item.name} — ${formatMoney(item.lineTotalCents)}`,
  );
  const htmlItemLines = items
    .map(
      (item) =>
        `<li>${item.quantity} &times; ${escapeHtml(item.name)} &mdash; ${escapeHtml(
          formatMoney(item.lineTotalCents),
        )}</li>`,
    )
    .join("");

  return {
    subject: `New pickup order ${orderId}`,
    text: [
      "New pickup order",
      "",
      `Order ID: ${orderId}`,
      `Status: ${status}`,
      `Placed: ${createdAt}`,
      `Customer: ${customerName}`,
      `Phone: ${phoneNumber}`,
      "",
      "Items:",
      ...plainItemLines,
      "",
      `Subtotal: ${subtotal}`,
      `Pickup note: ${customerNote}`,
    ].join("\n"),
    html: [
      "<h1>New pickup order</h1>",
      "<dl>",
      `<dt>Order ID</dt><dd>${escapeHtml(orderId)}</dd>`,
      `<dt>Status</dt><dd>${escapeHtml(status)}</dd>`,
      `<dt>Placed</dt><dd>${escapeHtml(createdAt)}</dd>`,
      `<dt>Customer</dt><dd>${escapeHtml(customerName)}</dd>`,
      `<dt>Phone</dt><dd>${escapeHtml(phoneNumber)}</dd>`,
      "</dl>",
      `<h2>Items</h2><ul>${htmlItemLines}</ul>`,
      `<p><strong>Subtotal:</strong> ${escapeHtml(subtotal)}</p>`,
      `<p><strong>Pickup note:</strong><br>${escapeHtml(customerNote).replace(
        /\n/gu,
        "<br>",
      )}</p>`,
    ].join(""),
  };
};

const isNotificationSent = (order) =>
  typeof order?.notificationStatus === "string" &&
  order.notificationStatus.trim().toUpperCase() === "SENT";

const isConditionalCheckFailure = (error) =>
  error?.name === "ConditionalCheckFailedException" ||
  error?.code === "ConditionalCheckFailedException";

const createNotifyOrderHandler = (dependencies = {}) => {
  const tableName = dependencies.tableName ?? process.env.ORDERS_TABLE;
  const fromEmail = dependencies.fromEmail ?? process.env.SES_FROM_EMAIL;
  const adminEmail =
    dependencies.adminEmail ?? process.env.ADMIN_ORDER_EMAIL;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  const processRecord = async (record) => {
    if (!tableName || !fromEmail || !adminEmail) {
      throw createProcessingError("MISSING_NOTIFICATION_CONFIG");
    }

    const orderEvent = parseOrderCreatedMessage(record?.body);
    const dynamoDefaults =
      dependencies.GetCommand && dependencies.UpdateCommand
        ? undefined
        : loadDynamoDependencies();
    const sesDefaults = dependencies.SendEmailCommand
      ? undefined
      : loadSesDependencies();
    const GetCommand = dependencies.GetCommand || dynamoDefaults.GetCommand;
    const UpdateCommand =
      dependencies.UpdateCommand || dynamoDefaults.UpdateCommand;
    const SendEmailCommand =
      dependencies.SendEmailCommand || sesDefaults.SendEmailCommand;
    const documentClient = getDocumentClient(dependencies);
    const sesClient = getSesClient(dependencies);

    const getResult = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { orderId: orderEvent.orderId },
        ConsistentRead: true,
      }),
    );
    const order = getResult?.Item;

    if (!order) {
      throw createProcessingError("ORDER_NOT_FOUND");
    }

    if (isNotificationSent(order)) {
      return { skipped: true };
    }

    if (order.orderId !== orderEvent.orderId) {
      throw createProcessingError("ORDER_ID_MISMATCH");
    }

    const email = createOrderEmail(order);
    const sendResult = await sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: fromEmail,
        Destination: {
          ToAddresses: [adminEmail],
        },
        Content: {
          Simple: {
            Subject: {
              Data: email.subject,
              Charset: "UTF-8",
            },
            Body: {
              Text: {
                Data: email.text,
                Charset: "UTF-8",
              },
              Html: {
                Data: email.html,
                Charset: "UTF-8",
              },
            },
          },
        },
      }),
    );

    const sentAtValue = now();
    const sentAt =
      sentAtValue instanceof Date
        ? sentAtValue.toISOString()
        : new Date(sentAtValue).toISOString();
    const messageId =
      typeof sendResult?.MessageId === "string" && sendResult.MessageId
        ? sendResult.MessageId
        : null;

    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { orderId: orderEvent.orderId },
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
            ":sentAt": sentAt,
            ":messageId": messageId,
          },
        }),
      );
    } catch (error) {
      // Another delivery may have completed between our consistent read and
      // this conditional update. Its SENT state is already the desired result.
      if (!isConditionalCheckFailure(error)) {
        throw error;
      }
    }

    return { skipped: false };
  };

  return async (event = {}) => {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const batchItemFailures = [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const itemIdentifier = String(
        record?.messageId || record?.messageID || `record-${index}`,
      );

      try {
        await processRecord(record);
      } catch (error) {
        batchItemFailures.push({ itemIdentifier });
        logger.error("Could not send an order notification", {
          messageId: itemIdentifier,
          errorName: error?.name,
          errorCode: error?.code,
          requestId: error?.$metadata?.requestId,
        });
      }
    }

    return { batchItemFailures };
  };
};

exports.ORDER_CREATED_EVENT = ORDER_CREATED_EVENT;
exports.ORDER_EVENT_VERSION = ORDER_EVENT_VERSION;
exports.createNotifyOrderHandler = createNotifyOrderHandler;
exports.createOrderEmail = createOrderEmail;
exports.escapeHtml = escapeHtml;
exports.parseOrderCreatedMessage = parseOrderCreatedMessage;
exports.fn = createNotifyOrderHandler();
