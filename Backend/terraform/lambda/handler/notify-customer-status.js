"use strict";

const ORDER_STATUS_CHANGED_EVENT = "ORDER_STATUS_CHANGED";
const ORDER_STATUS_EVENT_VERSION = 1;
const ORDER_ENTITY_TYPE = "ORDER";
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_EVENT_ID_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_RESTAURANT_NOTE_LENGTH = 500;
const MESSAGE_FIELDS = new Set([
  "eventType",
  "version",
  "eventId",
  "orderId",
  "previousStatus",
  "status",
  "changedAt",
]);
const ORDER_ID_PATTERN =
  /^ord_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+=-]*$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ORDER_STATUSES = Object.freeze([
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "REJECTED",
  "FAILED_TO_PICKUP",
]);
const NOTIFIABLE_STATUSES = new Set([
  "CONFIRMED",
  "CANCELLED",
  "REJECTED",
  "FAILED_TO_PICKUP",
]);
const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  PENDING: new Set(["CONFIRMED", "CANCELLED", "REJECTED"]),
  CONFIRMED: new Set(["CANCELLED", "FAILED_TO_PICKUP"]),
  CANCELLED: new Set(),
  REJECTED: new Set(),
  FAILED_TO_PICKUP: new Set(),
});

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
    } = require("@aws-sdk/lib-dynamodb");

    sharedDynamoDependencies = {
      DynamoDBClient,
      DynamoDBDocumentClient,
      GetCommand,
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
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const createProcessingError = (code) => {
  const error = new Error(code);
  error.name = "CustomerStatusNotificationError";
  error.code = code;
  return error;
};

const isCanonicalTimestamp = (value) => {
  if (
    typeof value !== "string" ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }

  const timestamp = new Date(value);
  return (
    !Number.isNaN(timestamp.getTime()) &&
    timestamp.toISOString() === value
  );
};

const hasExactFields = (value) => {
  const fields = Object.keys(value);
  return (
    fields.length === MESSAGE_FIELDS.size &&
    fields.every((field) => MESSAGE_FIELDS.has(field))
  );
};

const parseStatusChangedMessage = (body) => {
  if (
    typeof body !== "string" ||
    Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BYTES
  ) {
    throw createProcessingError("INVALID_MESSAGE");
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw createProcessingError("INVALID_MESSAGE_JSON");
  }

  if (!isPlainObject(payload) || !hasExactFields(payload)) {
    throw createProcessingError("INVALID_MESSAGE");
  }

  if (
    payload.eventType !== ORDER_STATUS_CHANGED_EVENT ||
    payload.version !== ORDER_STATUS_EVENT_VERSION
  ) {
    throw createProcessingError("UNSUPPORTED_ORDER_EVENT");
  }

  if (
    typeof payload.eventId !== "string" ||
    payload.eventId.length < 1 ||
    payload.eventId.length > MAX_EVENT_ID_LENGTH ||
    !EVENT_ID_PATTERN.test(payload.eventId)
  ) {
    throw createProcessingError("INVALID_EVENT_ID");
  }

  if (
    typeof payload.orderId !== "string" ||
    !ORDER_ID_PATTERN.test(payload.orderId)
  ) {
    throw createProcessingError("INVALID_ORDER_ID");
  }

  if (
    !ORDER_STATUSES.includes(payload.previousStatus) ||
    !NOTIFIABLE_STATUSES.has(payload.status)
  ) {
    throw createProcessingError("INVALID_ORDER_STATUS");
  }

  if (
    payload.previousStatus !== payload.status &&
    !ALLOWED_STATUS_TRANSITIONS[payload.previousStatus].has(payload.status)
  ) {
    throw createProcessingError("INVALID_STATUS_TRANSITION");
  }

  if (!isCanonicalTimestamp(payload.changedAt)) {
    throw createProcessingError("INVALID_CHANGED_AT");
  }

  return payload;
};

const normalizeEmailAddress = (value, errorCode) => {
  if (typeof value !== "string") {
    throw createProcessingError(errorCode);
  }

  const email = value.trim();
  const atIndex = email.lastIndexOf("@");
  if (
    !email ||
    email.length > MAX_EMAIL_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(email) ||
    !EMAIL_PATTERN.test(email) ||
    atIndex < 1 ||
    atIndex > 64 ||
    email.length - atIndex - 1 > 255
  ) {
    throw createProcessingError(errorCode);
  }

  return email;
};

const toDisplayText = (value, fallback, maxLength) => {
  if (typeof value !== "string") {
    return fallback;
  }

  const text = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();

  return text ? text.slice(0, maxLength) : fallback;
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");

const templateForStatus = (status) => {
  switch (status) {
    case "CONFIRMED":
      return {
        subject: "Your pickup order is confirmed",
        headline: "Your pickup order has been confirmed.",
      };
    case "CANCELLED":
      return {
        subject: "Your pickup order was cancelled",
        headline: "Your pickup order has been cancelled.",
      };
    case "REJECTED":
      return {
        subject: "We could not accept your pickup order",
        headline: "We could not accept your pickup order.",
      };
    case "FAILED_TO_PICKUP":
      return {
        subject: "Your order was marked as not picked up",
        headline: "Your pickup order was marked as not picked up.",
      };
    default:
      throw createProcessingError("INVALID_ORDER_STATUS");
  }
};

const createCustomerStatusEmail = (order, orderEvent) => {
  const template = templateForStatus(orderEvent.status);
  const customerName = toDisplayText(
    order.pickupContact?.name,
    "there",
    MAX_DISPLAY_NAME_LENGTH,
  );
  const restaurantNote = toDisplayText(
    order.restaurantNote,
    "",
    MAX_RESTAURANT_NOTE_LENGTH,
  );
  const detailLines = [];

  if (orderEvent.status === "CONFIRMED") {
    if (!isCanonicalTimestamp(order.pickupTime)) {
      throw createProcessingError("INVALID_STORED_PICKUP_TIME");
    }
    detailLines.push({
      label: "Pickup time",
      value: order.pickupTime,
    });
  }

  if (orderEvent.status === "FAILED_TO_PICKUP") {
    if (
      !isCanonicalTimestamp(order.scheduledPickupTime) ||
      !isCanonicalTimestamp(order.failedToPickupAt)
    ) {
      throw createProcessingError("INVALID_STORED_PICKUP_FAILURE");
    }
    detailLines.push(
      {
        label: "Scheduled pickup time",
        value: order.scheduledPickupTime,
      },
      {
        label: "Marked as not picked up",
        value: order.failedToPickupAt,
      },
    );
  }

  const textLines = [
    `Hello ${customerName},`,
    "",
    template.headline,
    "",
    `Order ID: ${orderEvent.orderId}`,
    ...detailLines.map(({ label, value }) => `${label}: ${value}`),
  ];
  const htmlDetails = [
    `<dt>Order ID</dt><dd>${escapeHtml(orderEvent.orderId)}</dd>`,
    ...detailLines.map(
      ({ label, value }) =>
        `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`,
    ),
  ];

  if (restaurantNote) {
    textLines.push("", "Message from the restaurant:", restaurantNote);
    htmlDetails.push(
      `<dt>Message from the restaurant</dt><dd>${escapeHtml(
        restaurantNote,
      ).replace(/\n/gu, "<br>")}</dd>`,
    );
  }

  textLines.push("", "Thank you.");

  return {
    subject: template.subject,
    text: textLines.join("\n"),
    html: [
      `<p>Hello ${escapeHtml(customerName)},</p>`,
      `<p>${escapeHtml(template.headline)}</p>`,
      `<dl>${htmlDetails.join("")}</dl>`,
      "<p>Thank you.</p>",
    ].join(""),
  };
};

const validateStoredOrder = (order, orderEvent) => {
  if (
    !isPlainObject(order) ||
    order.entityType !== ORDER_ENTITY_TYPE ||
    order.orderId !== orderEvent.orderId
  ) {
    throw createProcessingError("INVALID_STORED_ORDER");
  }
};

const safeLogValue = (value, fallback = "unknown") => {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.slice(0, 256);
  return /^[A-Za-z0-9][A-Za-z0-9._:/+=-]*$/u.test(normalized)
    ? normalized
    : fallback;
};

const createNotifyCustomerStatusHandler = (dependencies = {}) => {
  const tableName = dependencies.tableName ?? process.env.ORDERS_TABLE;
  const fromEmailValue =
    dependencies.fromEmail ?? process.env.SES_FROM_EMAIL;
  const logger = dependencies.logger || console;

  const processRecord = async (record) => {
    const orderEvent = parseStatusChangedMessage(record?.body);

    // A delivery describing no actual transition is harmless and must not
    // cause a database read or an email.
    if (orderEvent.previousStatus === orderEvent.status) {
      return { skipped: true, reason: "UNCHANGED_STATUS" };
    }

    if (!tableName || !fromEmailValue) {
      throw createProcessingError("MISSING_NOTIFICATION_CONFIG");
    }

    const fromEmail = normalizeEmailAddress(
      fromEmailValue,
      "INVALID_SENDER_EMAIL",
    );
    const dynamoDefaults = dependencies.GetCommand
      ? undefined
      : loadDynamoDependencies();
    const sesDefaults = dependencies.SendEmailCommand
      ? undefined
      : loadSesDependencies();
    const GetCommand = dependencies.GetCommand || dynamoDefaults.GetCommand;
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

    validateStoredOrder(order, orderEvent);

    // A newer status may already be stored by the time this delivery runs.
    // Completing the obsolete record without inspecting legacy contact data
    // avoids retrying an email that must no longer be sent.
    if (
      order.status !== orderEvent.status ||
      order.statusUpdatedAt !== orderEvent.changedAt
    ) {
      return { skipped: true, reason: "STALE_EVENT" };
    }

    const customerEmail = normalizeEmailAddress(
      order.customerEmail,
      "INVALID_CUSTOMER_EMAIL",
    );
    const email = createCustomerStatusEmail(order, orderEvent);
    await sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: fromEmail,
        Destination: {
          ToAddresses: [customerEmail],
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
        logger.error("Could not send a customer status notification", {
          messageId: safeLogValue(itemIdentifier),
          errorName: safeLogValue(error?.name),
          errorCode: safeLogValue(error?.code),
          requestId: safeLogValue(error?.$metadata?.requestId),
        });
      }
    }

    return { batchItemFailures };
  };
};

exports.ALLOWED_STATUS_TRANSITIONS = ALLOWED_STATUS_TRANSITIONS;
exports.NOTIFIABLE_STATUSES = NOTIFIABLE_STATUSES;
exports.ORDER_STATUS_CHANGED_EVENT = ORDER_STATUS_CHANGED_EVENT;
exports.ORDER_STATUS_EVENT_VERSION = ORDER_STATUS_EVENT_VERSION;
exports.createCustomerStatusEmail = createCustomerStatusEmail;
exports.createNotifyCustomerStatusHandler =
  createNotifyCustomerStatusHandler;
exports.escapeHtml = escapeHtml;
exports.isCanonicalTimestamp = isCanonicalTimestamp;
exports.parseStatusChangedMessage = parseStatusChangedMessage;
exports.fn = createNotifyCustomerStatusHandler();
