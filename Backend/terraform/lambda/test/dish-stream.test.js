"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createDeduplicationId,
  createDishStreamHandler,
  serializeChangeLog,
  toChangeLog,
  toChangeLogSummary,
  toDishChangeLogs,
  toIndexRefreshMessage,
} = require("../handler/dish-stream");

const imageFor = (dish) => ({
  id: { S: dish.id },
  category: { S: dish.category },
  name: { S: dish.name },
  description: { S: dish.description },
  price: { S: dish.price },
  ...(dish.allergens === undefined
    ? {}
    : {
        allergens: {
          L: dish.allergens.map((allergen) => ({ S: allergen })),
        },
      }),
  ...(dish.fullDishInfo === undefined ? {} : { fullDishInfo: { S: dish.fullDishInfo } }),
  ...(dish.availability === undefined
    ? {}
    : { availability: { S: dish.availability } }),
  ...(dish.image === undefined
    ? {}
    : {
        image: {
          M: {
            key: { S: dish.image.key },
            alt: { S: dish.image.alt },
            width: { N: String(dish.image.width) },
            height: { N: String(dish.image.height) },
          },
        },
      }),
});

const menuImageFor = (items, version) => ({
  id: { S: "MENU#CURRENT" },
  items: { L: items.map((item) => ({ M: imageFor(item) })) },
  version: { N: String(version) },
  updatedAt: { S: new Date(version).toISOString() },
  updatedBy: { S: "admin-user" },
});

const oldDish = {
  id: "sora-roll",
  category: "Maki",
  name: "Sora house roll",
  description: "Snow crab and avocado.",
  price: "22",
};

const newDish = { ...oldDish, price: "24" };
const unchangedDish = {
  id: "akami",
  category: "Nigiri",
  name: "Bluefin akami",
  description: "Lean bluefin and seasoned rice.",
  price: "14",
};

test("logs metadata without copying private dish content", async () => {
  const logLines = [];
  const handler = createDishStreamHandler({
    logger: { log(line) { logLines.push(line); } },
  });
  const event = {
    Records: [
      {
        eventID: "event-123",
        eventName: "MODIFY",
        dynamodb: {
          Keys: { id: { S: "sora-roll" } },
          OldImage: imageFor(oldDish),
          NewImage: imageFor(newDish),
          SequenceNumber: "111",
        },
      },
    ],
  };

  const result = await handler(event);

  assert.deepEqual(result, { processedRecords: 1 });
  assert.equal(logLines.length, 1);
  assert.deepEqual(JSON.parse(logLines[0]), {
    message: "DynamoDB dish changed",
    eventId: "event-123",
    eventName: "MODIFY",
    sequenceNumber: "111",
    keys: { id: "sora-roll" },
    changedFields: ["price"],
  });
  assert.ok(!logLines[0].includes("Snow crab"));
});

test("unmarshals the nested aggregate menu record", () => {
  const change = toChangeLog({
    eventName: "INSERT",
    dynamodb: {
      Keys: { id: { S: "MENU#CURRENT" } },
      NewImage: {
        id: { S: "MENU#CURRENT" },
        items: { L: [{ M: imageFor(newDish) }] },
        version: { N: "1773891000000" },
      },
    },
  });

  assert.deepEqual(change.newItem, {
    id: "MENU#CURRENT",
    items: [newDish],
    version: 1773891000000,
  });

  const serialized = serializeChangeLog(change);
  assert.deepEqual(JSON.parse(serialized).newItem.items, [newDish]);
});

test("logs only the modified dish from an aggregate menu update", async () => {
  const logLines = [];
  const handler = createDishStreamHandler({
    logger: { log(line) { logLines.push(line); } },
  });
  const event = {
    Records: [
      {
        eventID: "menu-event-123",
        eventName: "MODIFY",
        dynamodb: {
          Keys: { id: { S: "MENU#CURRENT" } },
          OldImage: menuImageFor([unchangedDish, oldDish], 1773891000000),
          NewImage: menuImageFor([unchangedDish, newDish], 1773892000000),
          SequenceNumber: "222",
        },
      },
    ],
  };

  await handler(event);

  assert.equal(logLines.length, 1);
  assert.deepEqual(JSON.parse(logLines[0]), {
    message: "DynamoDB dish changed",
    eventId: "menu-event-123",
    eventName: "MODIFY",
    sequenceNumber: "222",
    keys: { id: "sora-roll" },
    changedFields: ["price"],
  });
});

test("publishes only a minimal per-dish refresh message", async () => {
  const published = [];
  const privateDish = {
    ...newDish,
    allergens: ["shellfish"],
    fullDishInfo: "Private supplier and preparation notes.",
  };
  const handler = createDishStreamHandler({
    publishIndexRefresh: async (message) => published.push(message),
    logger: { log() {}, error() {} },
  });

  await handler({
    Records: [
      {
        eventID: "menu-event-456",
        eventName: "MODIFY",
        dynamodb: {
          Keys: { id: { S: "MENU#CURRENT" } },
          OldImage: menuImageFor([oldDish], 1773891000000),
          NewImage: menuImageFor([privateDish], 1773892000000),
          SequenceNumber: "333",
        },
      },
    ],
  });

  assert.deepEqual(published, [
    {
      eventType: "DISH_INDEX_REFRESH_REQUESTED",
      version: 1,
      eventId: "menu-event-456",
      eventName: "MODIFY",
      sequenceNumber: "333",
      dishId: "sora-roll",
    },
  ]);
  assert.ok(!JSON.stringify(published).includes("Private supplier"));
  assert.ok(!JSON.stringify(published).includes("shellfish"));
});

test("publishes a 50-dish menu change in SQS batches of at most 10", async () => {
  const batches = [];
  const dishes = Array.from({ length: 50 }, (_value, index) => ({
    ...newDish,
    id: `dish-${String(index + 1).padStart(2, "0")}`,
    name: `Dish ${index + 1}`,
    fullDishInfo: `Private preparation notes ${index + 1}`,
  }));
  const handler = createDishStreamHandler({
    queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/dishes.fifo",
    sendIndexRefreshBatch: async (input) => {
      batches.push(input);
      return {
        Successful: input.Entries.map(({ Id }) => ({ Id })),
        Failed: [],
      };
    },
    logger: { log() {}, error() {} },
  });

  await handler({
    Records: [
      {
        eventID: "bulk-menu-event",
        eventName: "INSERT",
        dynamodb: {
          Keys: { id: { S: "MENU#CURRENT" } },
          NewImage: menuImageFor(dishes, 1773892000000),
          SequenceNumber: "444",
        },
      },
    ],
  });

  assert.equal(batches.length, 5);
  assert.deepEqual(
    batches.map(({ Entries }) => Entries.length),
    [10, 10, 10, 10, 10],
  );
  const entries = batches.flatMap(({ Entries }) => Entries);
  const messages = entries.map(({ MessageBody }) => JSON.parse(MessageBody));
  assert.deepEqual(
    messages.map(({ dishId }) => dishId),
    dishes.map(({ id }) => id),
  );
  assert.ok(entries.every(({ Id }) => /^message-[0-9]$/.test(Id)));
  assert.ok(
    entries.every(
      ({ MessageGroupId, MessageDeduplicationId }, index) =>
        MessageGroupId === dishes[index].id &&
        /^[a-f0-9]{64}$/.test(MessageDeduplicationId),
    ),
  );
  assert.ok(!JSON.stringify(batches).includes("Private preparation notes"));
});

test("fails the stream record when SQS reports a failed batch entry", async () => {
  const errors = [];
  const handler = createDishStreamHandler({
    queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/dishes.fifo",
    sendIndexRefreshBatch: async () => ({
      Successful: [],
      Failed: [
        {
          Id: "message-0",
          Code: "InternalError",
          Message: "Do not copy provider details into logs",
          SenderFault: false,
        },
      ],
    }),
    logger: {
      log() {},
      error(message, details) {
        errors.push({ message, details });
      },
    },
  });

  await assert.rejects(
    handler({
      Records: [
        {
          eventID: "failed-batch-event",
          eventName: "INSERT",
          dynamodb: {
            Keys: { id: { S: "MENU#CURRENT" } },
            NewImage: menuImageFor([newDish], 1773892000000),
            SequenceNumber: "445",
          },
        },
      ],
    }),
    { name: "SqsBatchFailure" },
  );

  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], {
    message: "Could not enqueue one or more dish index refreshes",
    details: {
      failures: [
        {
          id: "message-0",
          code: "InternalError",
          senderFault: false,
        },
      ],
    },
  });
});

test("builds stable refresh and FIFO deduplication metadata", () => {
  const change = {
    eventId: "event-123",
    eventName: "MODIFY",
    sequenceNumber: "111",
    keys: { id: "sora-roll" },
    oldItem: oldDish,
    newItem: newDish,
  };

  const message = toIndexRefreshMessage(change);
  assert.equal(message.dishId, "sora-roll");
  assert.match(createDeduplicationId(message), /^[a-f0-9]{64}$/);
  assert.equal(
    createDeduplicationId(message),
    createDeduplicationId(toIndexRefreshMessage(change)),
  );
  assert.deepEqual(toChangeLogSummary(change).changedFields, ["price"]);
});

test("detects added and removed dishes in an aggregate menu", () => {
  const addedDish = { ...newDish, id: "new-roll", name: "New roll" };
  const changes = toDishChangeLogs({
    eventName: "MODIFY",
    dynamodb: {
      Keys: { id: { S: "MENU#CURRENT" } },
      OldImage: menuImageFor([unchangedDish, oldDish], 1773891000000),
      NewImage: menuImageFor([unchangedDish, addedDish], 1773892000000),
    },
  });

  assert.deepEqual(
    changes.map(({ eventName, oldItem, newItem }) => ({
      eventName,
      oldId: oldItem?.id || null,
      newId: newItem?.id || null,
    })),
    [
      { eventName: "INSERT", oldId: null, newId: "new-roll" },
      { eventName: "REMOVE", oldId: "sora-roll", newId: null },
    ],
  );
});

test("does not log metadata-only updates or menu reordering", async () => {
  let logCalls = 0;
  const handler = createDishStreamHandler({
    logger: { log() { logCalls += 1; } },
  });

  await handler({
    Records: [
      {
        eventName: "MODIFY",
        dynamodb: {
          Keys: { id: { S: "MENU#CURRENT" } },
          OldImage: menuImageFor([unchangedDish, oldDish], 1773891000000),
          NewImage: menuImageFor([oldDish, unchangedDish], 1773892000000),
        },
      },
    ],
  });

  assert.equal(logCalls, 0);
});

test("detects allergen and private RAG context changes", () => {
  const withMetadata = {
    ...oldDish,
    allergens: ["shellfish", "wheat"],
    fullDishInfo: "Snow crab is delivered on Tuesday.",
  };
  const allergenChange = toDishChangeLogs({
    eventName: "MODIFY",
    dynamodb: {
      Keys: { id: { S: "MENU#CURRENT" } },
      OldImage: menuImageFor([oldDish], 1773891000000),
      NewImage: menuImageFor([withMetadata], 1773892000000),
    },
  });
  assert.equal(allergenChange.length, 1);
  assert.equal(allergenChange[0].eventName, "MODIFY");
  assert.deepEqual(allergenChange[0].newItem, withMetadata);

  const ragChange = toDishChangeLogs({
    eventName: "MODIFY",
    dynamodb: {
      Keys: { id: { S: "MENU#CURRENT" } },
      OldImage: menuImageFor([withMetadata], 1773892000000),
      NewImage: menuImageFor(
        [{ ...withMetadata, fullDishInfo: "Snow crab is delivered on Friday." }],
        1773893000000,
      ),
    },
  });
  assert.equal(ragChange.length, 1);
  assert.equal(ragChange[0].eventName, "MODIFY");
});

test("detects availability changes for future RAG updates", () => {
  const unavailableDish = { ...oldDish, availability: "out" };
  const changes = toDishChangeLogs({
    eventName: "MODIFY",
    dynamodb: {
      Keys: { id: { S: "MENU#CURRENT" } },
      OldImage: menuImageFor([oldDish], 1773891000000),
      NewImage: menuImageFor([unavailableDish], 1773892000000),
    },
  });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].eventName, "MODIFY");
  assert.equal(changes[0].oldItem.availability, undefined);
  assert.equal(changes[0].newItem.availability, "out");
});

test("detects image metadata changes", () => {
  const withImage = {
    ...oldDish,
    image: {
      key: "dishes/sora-roll/old-image.webp",
      alt: "Sora house roll",
      width: 800,
      height: 600,
    },
  };
  const replacement = {
    ...withImage,
    image: {
      ...withImage.image,
      key: "dishes/sora-roll/new-image.webp",
    },
  };
  const changes = toDishChangeLogs({
    eventName: "MODIFY",
    dynamodb: {
      Keys: { id: { S: "MENU#CURRENT" } },
      OldImage: menuImageFor([withImage], 1773891000000),
      NewImage: menuImageFor([replacement], 1773892000000),
    },
  });

  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].oldItem.image, withImage.image);
  assert.deepEqual(changes[0].newItem.image, replacement.image);
});

test("removes obsolete S3 images after saved replacements and removals", async () => {
  const deletedKeys = [];
  const handler = createDishStreamHandler({
    bucketName: "dish-images-test",
    deleteImage: async (key) => deletedKeys.push(key),
    logger: { log() {}, error() {} },
  });
  const withImage = {
    ...oldDish,
    image: {
      key: "dishes/sora-roll/old-image.webp",
      alt: "Sora house roll",
      width: 800,
      height: 600,
    },
  };
  const replacement = {
    ...withImage,
    image: {
      ...withImage.image,
      key: "dishes/sora-roll/new-image.webp",
    },
  };

  await handler({
    Records: [
      {
        eventName: "MODIFY",
        dynamodb: {
          Keys: { id: { S: "MENU#CURRENT" } },
          OldImage: menuImageFor([withImage], 1773891000000),
          NewImage: menuImageFor([replacement], 1773892000000),
        },
      },
      {
        eventName: "MODIFY",
        dynamodb: {
          Keys: { id: { S: "MENU#CURRENT" } },
          OldImage: menuImageFor([replacement], 1773892000000),
          NewImage: menuImageFor([], 1773893000000),
        },
      },
    ],
  });

  assert.deepEqual(deletedKeys, [
    "dishes/sora-roll/old-image.webp",
    "dishes/sora-roll/new-image.webp",
  ]);
});

test("batches obsolete S3 image deletion after queue publication", async () => {
  const deleteInputs = [];
  const withImage = {
    ...oldDish,
    image: {
      key: "dishes/sora-roll/old-image.webp",
      alt: "Sora house roll",
      width: 800,
      height: 600,
    },
  };
  const replacement = {
    ...withImage,
    image: {
      ...withImage.image,
      key: "dishes/sora-roll/new-image.webp",
    },
  };
  const handler = createDishStreamHandler({
    bucketName: "dish-images-test",
    deleteImages: async (input) => {
      deleteInputs.push(input);
      return { Deleted: [], Errors: [] };
    },
    logger: { log() {}, error() {} },
  });

  await handler({
    Records: [
      {
        eventName: "MODIFY",
        dynamodb: {
          Keys: { id: { S: "MENU#CURRENT" } },
          OldImage: menuImageFor([withImage], 1773891000000),
          NewImage: menuImageFor([replacement], 1773892000000),
        },
      },
      {
        eventName: "MODIFY",
        dynamodb: {
          Keys: { id: { S: "MENU#CURRENT" } },
          OldImage: menuImageFor([replacement], 1773892000000),
          NewImage: menuImageFor([], 1773893000000),
        },
      },
    ],
  });

  assert.deepEqual(deleteInputs, [
    {
      Bucket: "dish-images-test",
      Delete: {
        Objects: [
          { Key: "dishes/sora-roll/old-image.webp" },
          { Key: "dishes/sora-roll/new-image.webp" },
        ],
        Quiet: true,
      },
    },
  ]);
});

test("does not remove an image when only its alt text changes", async () => {
  const deletedKeys = [];
  const handler = createDishStreamHandler({
    bucketName: "dish-images-test",
    deleteImage: async (key) => deletedKeys.push(key),
    logger: { log() {}, error() {} },
  });
  const withImage = {
    ...oldDish,
    image: {
      key: "dishes/sora-roll/current-image.webp",
      alt: "Sora house roll",
      width: 800,
      height: 600,
    },
  };

  await handler({
    Records: [
      {
        eventName: "MODIFY",
        dynamodb: {
          Keys: { id: { S: "MENU#CURRENT" } },
          OldImage: menuImageFor([withImage], 1773891000000),
          NewImage: menuImageFor(
            [
              {
                ...withImage,
                image: { ...withImage.image, alt: "House roll with tuna" },
              },
            ],
            1773892000000,
          ),
        },
      },
    ],
  });

  assert.deepEqual(deletedKeys, []);
});

test("treats missing metadata and empty defaults as the same dish", () => {
  const changes = toDishChangeLogs({
    eventName: "MODIFY",
    dynamodb: {
      Keys: { id: { S: "MENU#CURRENT" } },
      OldImage: menuImageFor([oldDish], 1773891000000),
      NewImage: menuImageFor(
        [
          {
            ...oldDish,
            allergens: [],
            fullDishInfo: "",
            availability: "available",
          },
        ],
        1773892000000,
      ),
    },
  });

  assert.deepEqual(changes, []);
});

test("serializes large DynamoDB numbers without failing on BigInt", () => {
  const serialized = serializeChangeLog({
    oldItem: { largeNumber: 9007199254740993n },
    newItem: { tags: new Set(["maki", "special"]) },
  });

  assert.deepEqual(JSON.parse(serialized), {
    oldItem: { largeNumber: "9007199254740993" },
    newItem: { tags: ["maki", "special"] },
  });
});

test("shows null for the old image on an insert", () => {
  const change = toChangeLog({
    eventName: "INSERT",
    dynamodb: {
      Keys: { id: { S: "sora-roll" } },
      NewImage: imageFor(newDish),
    },
  });

  assert.equal(change.oldItem, null);
  assert.deepEqual(change.newItem, newDish);
});

test("shows null for the new image on a removal", () => {
  const change = toChangeLog({
    eventName: "REMOVE",
    dynamodb: {
      Keys: { id: { S: "sora-roll" } },
      OldImage: imageFor(oldDish),
    },
  });

  assert.deepEqual(change.oldItem, oldDish);
  assert.equal(change.newItem, null);
});

test("accepts an event without records", async () => {
  let logCalls = 0;
  const handler = createDishStreamHandler({
    logger: { log() { logCalls += 1; } },
  });

  const result = await handler(null);

  assert.deepEqual(result, { processedRecords: 0 });
  assert.equal(logCalls, 0);
});
