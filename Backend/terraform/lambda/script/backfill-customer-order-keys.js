"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { customerOrderKeyFor } = require("../handler/order-keys");

const ORDER_ENTITY_TYPE = "ORDER";

const isConditionalFailure = (error) =>
  error?.name === "ConditionalCheckFailedException";

const createDocumentClient = () =>
  DynamoDBDocumentClient.from(new DynamoDBClient({}));

const backfillCustomerOrderKeys = async ({
  documentClient = createDocumentClient(),
  tableName = process.env.ORDERS_TABLE,
} = {}) => {
  if (!tableName) {
    throw new Error("ORDERS_TABLE is required.");
  }

  const counts = {
    pages: 0,
    scanned: 0,
    matched: 0,
    updated: 0,
    skipped: 0,
    conflicts: 0,
  };
  let exclusiveStartKey;

  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          "#entityType = :orderType AND " +
          "attribute_type(#customerId, :stringType) AND " +
          "attribute_not_exists(#customerOrderKey)",
        ProjectionExpression: "#orderId, #entityType, #customerId",
        ExpressionAttributeNames: {
          "#orderId": "orderId",
          "#entityType": "entityType",
          "#customerId": "customerId",
          "#customerOrderKey": "customerOrderKey",
        },
        ExpressionAttributeValues: {
          ":orderType": ORDER_ENTITY_TYPE,
          ":stringType": "S",
        },
        ...(exclusiveStartKey
          ? { ExclusiveStartKey: exclusiveStartKey }
          : {}),
      }),
    );

    counts.pages += 1;
    counts.scanned += Number.isSafeInteger(response.ScannedCount)
      ? response.ScannedCount
      : 0;

    const items = Array.isArray(response.Items) ? response.Items : [];
    counts.matched += items.length;

    for (const item of items) {
      if (
        item?.entityType !== ORDER_ENTITY_TYPE ||
        typeof item.orderId !== "string" ||
        !item.orderId ||
        typeof item.customerId !== "string" ||
        !item.customerId.trim()
      ) {
        counts.skipped += 1;
        continue;
      }

      const customerId = item.customerId.trim();
      try {
        await documentClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { orderId: item.orderId },
            UpdateExpression:
              "SET #customerOrderKey = :customerOrderKey",
            ConditionExpression:
              "#entityType = :orderType AND " +
              "#customerId = :customerId AND " +
              "attribute_not_exists(#customerOrderKey)",
            ExpressionAttributeNames: {
              "#entityType": "entityType",
              "#customerId": "customerId",
              "#customerOrderKey": "customerOrderKey",
            },
            ExpressionAttributeValues: {
              ":orderType": ORDER_ENTITY_TYPE,
              ":customerId": item.customerId,
              ":customerOrderKey": customerOrderKeyFor(customerId),
            },
          }),
        );
        counts.updated += 1;
      } catch (error) {
        if (isConditionalFailure(error)) {
          counts.conflicts += 1;
          continue;
        }
        throw error;
      }
    }

    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return counts;
};

const main = async () => {
  try {
    const counts = await backfillCustomerOrderKeys();
    console.log(JSON.stringify(counts));
  } catch {
    console.error("Customer order history backfill failed.");
    process.exitCode = 1;
  }
};

if (require.main === module) {
  main();
}

exports.ORDER_ENTITY_TYPE = ORDER_ENTITY_TYPE;
exports.backfillCustomerOrderKeys = backfillCustomerOrderKeys;
