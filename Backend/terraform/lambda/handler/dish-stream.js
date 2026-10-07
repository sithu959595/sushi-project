"use strict";

const { createHash } = require("node:crypto");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

const MENU_RECORD_ID = "MENU#CURRENT";
const DISH_IMAGE_KEY_PATTERN =
  /^dishes\/([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*)\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}\.(jpg|jpeg|png|webp)$/;
const DISH_FIELDS = [
  "id",
  "category",
  "name",
  "description",
  "price",
  "allergens",
  "fullDishInfo",
  "image",
  "availability",
];

let sharedS3Dependencies;
let sharedS3Client;
let sharedSqsDependencies;
let sharedSqsClient;

const loadS3Dependencies = () => {
  if (!sharedS3Dependencies) {
    const { DeleteObjectsCommand, S3Client } = require("@aws-sdk/client-s3");
    sharedS3Dependencies = { DeleteObjectsCommand, S3Client };
  }

  return sharedS3Dependencies;
};

const getS3Client = (S3Client) => {
  if (!sharedS3Client) {
    sharedS3Client = new S3Client({});
  }

  return sharedS3Client;
};

const loadSqsDependencies = () => {
  if (!sharedSqsDependencies) {
    const { SendMessageBatchCommand, SQSClient } = require("@aws-sdk/client-sqs");
    sharedSqsDependencies = { SendMessageBatchCommand, SQSClient };
  }

  return sharedSqsDependencies;
};

const getSqsClient = (SQSClient) => {
  if (!sharedSqsClient) {
    sharedSqsClient = new SQSClient({});
  }

  return sharedSqsClient;
};

const unmarshallImage = (image) => {
  if (!image) {
    return null;
  }

  return unmarshall(image);
};

const toChangeLog = (record) => ({
  message: "DynamoDB dish changed",
  eventId: record.eventID || null,
  eventName: record.eventName || null,
  sequenceNumber: record.dynamodb?.SequenceNumber || null,
  keys: unmarshallImage(record.dynamodb?.Keys),
  oldItem: unmarshallImage(record.dynamodb?.OldImage),
  newItem: unmarshallImage(record.dynamodb?.NewImage),
});

const fieldValuesAreEqual = (field, left, right) => {
  if (field === "allergens") {
    const leftAllergens = Array.isArray(left) ? left : [];
    const rightAllergens = Array.isArray(right) ? right : [];
    return (
      leftAllergens.length === rightAllergens.length &&
      leftAllergens.every(
        (allergen, index) => allergen === rightAllergens[index],
      )
    );
  }

  if (field === "fullDishInfo") {
    return (left ?? "") === (right ?? "");
  }

  if (field === "availability") {
    return (left ?? "available") === (right ?? "available");
  }

  if (field === "image") {
    if (!left && !right) {
      return true;
    }

    return (
      left?.key === right?.key &&
      (left?.alt ?? "") === (right?.alt ?? "") &&
      left?.width === right?.width &&
      left?.height === right?.height
    );
  }

  return left === right;
};

const dishesAreEqual = (left, right) =>
  DISH_FIELDS.every((field) =>
    fieldValuesAreEqual(field, left?.[field], right?.[field]),
  );

const toDishChange = (streamChange, eventName, oldItem, newItem) => ({
  ...streamChange,
  eventName,
  keys: { id: newItem?.id || oldItem?.id || null },
  oldItem,
  newItem,
});

const toDishChangeLogs = (record) => {
  const streamChange = toChangeLog(record);
  if (streamChange.keys?.id !== MENU_RECORD_ID) {
    return [streamChange];
  }

  const oldItems = Array.isArray(streamChange.oldItem?.items)
    ? streamChange.oldItem.items
    : [];
  const newItems = Array.isArray(streamChange.newItem?.items)
    ? streamChange.newItem.items
    : [];
  const oldItemsById = new Map(oldItems.map((item) => [item.id, item]));
  const newItemsById = new Map(newItems.map((item) => [item.id, item]));
  const changes = [];

  for (const newItem of newItems) {
    const oldItem = oldItemsById.get(newItem.id);
    if (!oldItem) {
      changes.push(toDishChange(streamChange, "INSERT", null, newItem));
    } else if (!dishesAreEqual(oldItem, newItem)) {
      changes.push(toDishChange(streamChange, "MODIFY", oldItem, newItem));
    }
  }

  for (const oldItem of oldItems) {
    if (!newItemsById.has(oldItem.id)) {
      changes.push(toDishChange(streamChange, "REMOVE", oldItem, null));
    }
  }

  return changes;
};

const serializeChangeLog = (change) =>
  JSON.stringify(change, (_key, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }

    if (value instanceof Set) {
      return [...value];
    }

    return value;
  });

const getChangedFields = (change) => {
  if (!change?.oldItem) {
    return DISH_FIELDS.filter((field) => change?.newItem?.[field] !== undefined);
  }

  if (!change?.newItem) {
    return DISH_FIELDS.filter((field) => change?.oldItem?.[field] !== undefined);
  }

  return DISH_FIELDS.filter(
    (field) =>
      !fieldValuesAreEqual(
        field,
        change.oldItem?.[field],
        change.newItem?.[field],
      ),
  );
};

const toChangeLogSummary = (change) => ({
  message: "DynamoDB dish changed",
  eventId: change?.eventId || null,
  eventName: change?.eventName || null,
  sequenceNumber: change?.sequenceNumber || null,
  keys: { id: change?.keys?.id || null },
  changedFields: getChangedFields(change),
});

const toIndexRefreshMessage = (change) => {
  const dishId = change?.keys?.id;
  if (typeof dishId !== "string" || !dishId.trim()) {
    return null;
  }

  return {
    eventType: "DISH_INDEX_REFRESH_REQUESTED",
    version: 1,
    eventId: change?.eventId || null,
    eventName: change?.eventName || null,
    sequenceNumber: change?.sequenceNumber || null,
    dishId: dishId.trim(),
  };
};

const createDeduplicationId = (message) =>
  createHash("sha256")
    .update(
      [
        message.eventId || "",
        message.sequenceNumber || "",
        message.eventName || "",
        message.dishId,
      ].join(":"),
    )
    .digest("hex");

const chunkMessages = (messages, size = 10) => {
  const chunks = [];
  for (let index = 0; index < messages.length; index += size) {
    chunks.push(messages.slice(index, index + size));
  }
  return chunks;
};

const toSqsBatchEntries = (messages) =>
  messages.map((message, index) => ({
    Id: `message-${index}`,
    MessageBody: JSON.stringify(message),
    MessageGroupId: message.dishId,
    MessageDeduplicationId: createDeduplicationId(message),
  }));

const getObsoleteImageKey = (change) => {
  const oldKey = change?.oldItem?.image?.key;
  const newKey = change?.newItem?.image?.key;
  const keyMatch =
    typeof oldKey === "string" ? DISH_IMAGE_KEY_PATTERN.exec(oldKey) : null;

  return keyMatch &&
    keyMatch[1] === change?.oldItem?.id &&
    oldKey !== newKey
    ? oldKey
    : null;
};

const createDishStreamHandler = (dependencies = {}) => {
  const logger = dependencies.logger || console;
  const bucketName =
    dependencies.bucketName ?? process.env.DISH_IMAGES_BUCKET ?? "";
  const queueUrl =
    dependencies.queueUrl ?? process.env.DISH_INDEX_UPDATES_QUEUE_URL ?? "";

  return async (event = {}) => {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const changes = records.flatMap(toDishChangeLogs);

    for (const change of changes) {
      logger.log(serializeChangeLog(toChangeLogSummary(change)));
    }

    const indexRefreshMessages = changes
      .map(toIndexRefreshMessage)
      .filter(Boolean);
    if (dependencies.publishIndexRefresh) {
      for (const message of indexRefreshMessages) {
        await dependencies.publishIndexRefresh(message);
      }
    } else if (
      indexRefreshMessages.length > 0 &&
      (dependencies.sendIndexRefreshBatch || queueUrl)
    ) {
      for (const batch of chunkMessages(indexRefreshMessages)) {
        const input = {
          QueueUrl: queueUrl,
          Entries: toSqsBatchEntries(batch),
        };

        try {
          let response;
          if (dependencies.sendIndexRefreshBatch) {
            response = await dependencies.sendIndexRefreshBatch(input);
          } else {
            const { SendMessageBatchCommand, SQSClient } = loadSqsDependencies();
            response = await getSqsClient(SQSClient).send(
              new SendMessageBatchCommand(input),
            );
          }

          const failedEntries = Array.isArray(response?.Failed)
            ? response.Failed
            : [];
          if (failedEntries.length > 0) {
            logger.error("Could not enqueue one or more dish index refreshes", {
              failures: failedEntries.map((entry) => ({
                id: entry?.Id || null,
                code: entry?.Code || null,
                senderFault: entry?.SenderFault === true,
              })),
            });
            const error = new Error("An SQS batch entry failed");
            error.name = "SqsBatchFailure";
            throw error;
          }
        } catch (error) {
          if (error?.name !== "SqsBatchFailure") {
            logger.error("Could not enqueue dish index refresh batch", {
              errorName: error?.name,
              requestId: error?.$metadata?.requestId,
              dishIds: batch.map(({ dishId }) => dishId),
            });
          }
          throw error;
        }
      }
    }

    const obsoleteImageKeys = changes.map(getObsoleteImageKey).filter(Boolean);
    if (obsoleteImageKeys.length === 0 || !bucketName) {
      return { processedRecords: records.length };
    }

    if (dependencies.deleteImage) {
      for (const obsoleteImageKey of obsoleteImageKeys) {
        try {
          await dependencies.deleteImage(obsoleteImageKey);
        } catch (error) {
          logger.error("Could not remove replaced dish image", {
            errorName: error?.name,
            requestId: error?.$metadata?.requestId,
            key: obsoleteImageKey,
          });
          throw error;
        }
      }
    } else {
      try {
        const input = {
          Bucket: bucketName,
          Delete: {
            Objects: obsoleteImageKeys.map((Key) => ({ Key })),
            Quiet: true,
          },
        };
        let response;
        if (dependencies.deleteImages) {
          response = await dependencies.deleteImages(input);
        } else {
          const { DeleteObjectsCommand, S3Client } = loadS3Dependencies();
          response = await getS3Client(S3Client).send(
            new DeleteObjectsCommand(input),
          );
        }

        const failures = Array.isArray(response?.Errors) ? response.Errors : [];
        if (failures.length > 0) {
          logger.error("Could not remove one or more replaced dish images", {
            failures: failures.map((failure) => ({
              key: failure?.Key || null,
              code: failure?.Code || null,
            })),
          });
          const error = new Error("An S3 delete entry failed");
          error.name = "S3BatchDeleteFailure";
          throw error;
        }
      } catch (error) {
        if (error?.name !== "S3BatchDeleteFailure") {
          logger.error("Could not remove replaced dish images", {
            errorName: error?.name,
            requestId: error?.$metadata?.requestId,
            keys: obsoleteImageKeys,
          });
        }
        throw error;
      }
    }

    return { processedRecords: records.length };
  };
};

exports.createDishStreamHandler = createDishStreamHandler;
exports.createDeduplicationId = createDeduplicationId;
exports.getChangedFields = getChangedFields;
exports.getObsoleteImageKey = getObsoleteImageKey;
exports.fn = createDishStreamHandler();
exports.serializeChangeLog = serializeChangeLog;
exports.toSqsBatchEntries = toSqsBatchEntries;
exports.toChangeLog = toChangeLog;
exports.toChangeLogSummary = toChangeLogSummary;
exports.toDishChangeLogs = toDishChangeLogs;
exports.toIndexRefreshMessage = toIndexRefreshMessage;
