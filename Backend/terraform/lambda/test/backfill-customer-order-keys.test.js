"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  backfillCustomerOrderKeys,
} = require("../script/backfill-customer-order-keys");

test("paginates scans and conditionally indexes only valid order records", async () => {
  const calls = [];
  let scanCount = 0;
  const documentClient = {
    async send(command) {
      calls.push(command);
      const input = command.input;

      if (input.FilterExpression) {
        scanCount += 1;
        if (scanCount === 1) {
          return {
            ScannedCount: 7,
            Items: [
              {
                orderId: "ord_first",
                entityType: "ORDER",
                customerId: "customer-one",
              },
              {
                orderId: "ord_missing_customer",
                entityType: "ORDER",
                customerId: " ",
              },
              {
                orderId: "marker",
                entityType: "IDEMPOTENCY",
                customerId: "customer-one",
              },
            ],
            LastEvaluatedKey: { orderId: "page-one-key" },
          };
        }

        assert.deepEqual(input.ExclusiveStartKey, {
          orderId: "page-one-key",
        });
        return {
          ScannedCount: 3,
          Items: [
            {
              orderId: "ord_second",
              entityType: "ORDER",
              customerId: "customer-two",
            },
          ],
        };
      }

      if (
        input.ExpressionAttributeValues[":customerId"] === "customer-two"
      ) {
        const error = new Error("changed concurrently");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }

      return {};
    },
  };

  const counts = await backfillCustomerOrderKeys({
    documentClient,
    tableName: "orders-test",
  });

  assert.deepEqual(counts, {
    pages: 2,
    scanned: 10,
    matched: 4,
    updated: 1,
    skipped: 2,
    conflicts: 1,
  });

  const scanCalls = calls.filter(
    ({ input }) => typeof input.FilterExpression === "string",
  );
  assert.equal(scanCalls.length, 2);
  assert.match(scanCalls[0].input.FilterExpression, /#entityType/u);
  assert.match(
    scanCalls[0].input.FilterExpression,
    /attribute_not_exists\(#customerOrderKey\)/u,
  );
  assert.equal(
    scanCalls[0].input.ExpressionAttributeValues[":orderType"],
    "ORDER",
  );
  assert.deepEqual(
    scanCalls[0].input.ProjectionExpression,
    "#orderId, #entityType, #customerId",
  );

  const updateCalls = calls.filter(
    ({ input }) => typeof input.UpdateExpression === "string",
  );
  assert.equal(updateCalls.length, 2);
  assert.deepEqual(updateCalls[0].input.Key, { orderId: "ord_first" });
  assert.equal(
    updateCalls[0].input.ExpressionAttributeValues[":customerOrderKey"],
    "CUSTOMER#customer-one",
  );
  assert.equal(
    updateCalls[1].input.ExpressionAttributeValues[":customerOrderKey"],
    "CUSTOMER#customer-two",
  );
  for (const { input } of updateCalls) {
    assert.match(
      input.ConditionExpression,
      /attribute_not_exists\(#customerOrderKey\)/u,
    );
    assert.match(input.ConditionExpression, /#entityType = :orderType/u);
    assert.match(input.ConditionExpression, /#customerId = :customerId/u);
  }
});

test("requires an explicit orders table before making AWS calls", async () => {
  let calls = 0;
  const documentClient = {
    async send() {
      calls += 1;
      return {};
    },
  };

  await assert.rejects(
    backfillCustomerOrderKeys({
      documentClient,
      tableName: "",
    }),
    /ORDERS_TABLE is required/u,
  );
  assert.equal(calls, 0);
});

test("stops on non-conditional DynamoDB failures", async () => {
  let calls = 0;
  const documentClient = {
    async send(command) {
      calls += 1;
      if (command.input.FilterExpression) {
        return {
          ScannedCount: 1,
          Items: [
            {
              orderId: "ord_failure",
              entityType: "ORDER",
              customerId: "customer-one",
            },
          ],
        };
      }

      const error = new Error("DynamoDB unavailable");
      error.name = "InternalServerError";
      throw error;
    },
  };

  await assert.rejects(
    backfillCustomerOrderKeys({
      documentClient,
      tableName: "orders-test",
    }),
    { name: "InternalServerError" },
  );
  assert.equal(calls, 2);
});
