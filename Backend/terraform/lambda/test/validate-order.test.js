"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_CUSTOMER_NOTE_LENGTH,
  MAX_ITEM_QUANTITY,
  MAX_TOTAL_QUANTITY,
  validateOrderPayload,
} = require("../handler/validate-order");

const validOrder = {
  clientRequestId: "order-550e8400-e29b-41d4-a716-446655440000",
  items: [{ dishId: "sora-roll", quantity: 2 }],
  fulfillment: "pickup",
  pickupContact: {
    name: "Sithu Lin",
    phoneNumber: "+14155552671",
  },
  customerNote: "Please include chopsticks.",
};

const fieldsFor = (payload) =>
  validateOrderPayload(payload).errors.map(({ field }) => field);

test("normalizes the exact frontend order format", () => {
  const validation = validateOrderPayload({
    ...validOrder,
    clientRequestId: `  ${validOrder.clientRequestId}  `,
    items: [{ dishId: "  sora-roll  ", quantity: 2 }],
    pickupContact: {
      name: "  Sithu Lin  ",
      phoneNumber: "  +14155552671  ",
    },
    customerNote: "  Please include chopsticks.  ",
  });

  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.value, validOrder);
});

test("allows an omitted or empty customer note and normalizes it", () => {
  const withoutNote = { ...validOrder };
  delete withoutNote.customerNote;

  assert.equal(validateOrderPayload(withoutNote).value.customerNote, "");
  assert.equal(
    validateOrderPayload({ ...validOrder, customerNote: "   " }).value
      .customerNote,
    "",
  );
});

test("requires an exact top-level object", () => {
  assert.deepEqual(fieldsFor(null), ["body"]);
  assert.deepEqual(fieldsFor([]), ["body"]);

  const fields = fieldsFor({
    ...validOrder,
    customerId: "forged-user",
    subtotalCents: 1,
  });
  assert.ok(fields.includes("customerId"));
  assert.ok(fields.includes("subtotalCents"));
});

test("validates client request IDs and pickup-only fulfillment", () => {
  for (const clientRequestId of [
    undefined,
    "",
    "short",
    "contains spaces",
    "bad#id",
  ]) {
    assert.ok(
      fieldsFor({ ...validOrder, clientRequestId }).includes("clientRequestId"),
      String(clientRequestId),
    );
  }

  for (const fulfillment of [undefined, "delivery", "PICKUP", 42]) {
    assert.ok(
      fieldsFor({ ...validOrder, fulfillment }).includes("fulfillment"),
      String(fulfillment),
    );
  }
});

test("validates line-item shape, IDs, quantities, and duplicates", () => {
  const validation = validateOrderPayload({
    ...validOrder,
    items: [
      { dishId: "sora-roll", quantity: 0, price: "0.01" },
      { dishId: "sora-roll", quantity: 1.5 },
      { dishId: "bad dish id", quantity: MAX_ITEM_QUANTITY + 1 },
      null,
    ],
  });
  const fields = validation.errors.map(({ field }) => field);

  for (const field of [
    "items[0].price",
    "items[0].quantity",
    "items[1].dishId",
    "items[1].quantity",
    "items[2].dishId",
    "items[2].quantity",
    "items[3]",
  ]) {
    assert.ok(fields.includes(field), field);
  }
});

test("limits both line count and total quantity", () => {
  assert.ok(fieldsFor({ ...validOrder, items: [] }).includes("items"));
  assert.ok(fieldsFor({ ...validOrder, items: "not-an-array" }).includes("items"));

  const tooManyTotal = Array.from(
    { length: Math.floor(MAX_TOTAL_QUANTITY / MAX_ITEM_QUANTITY) + 1 },
    (_, index) => ({
      dishId: `dish-${index}`,
      quantity: MAX_ITEM_QUANTITY,
    }),
  );
  assert.ok(
    validateOrderPayload({ ...validOrder, items: tooManyTotal }).errors.some(
      ({ field, message }) =>
        field === "items" && message.includes(String(MAX_TOTAL_QUANTITY)),
    ),
  );
});

test("strictly validates pickup contact and customer note", () => {
  const invalidContacts = [
    null,
    {},
    { name: "", phoneNumber: "+14155552671" },
    { name: "Customer", phoneNumber: "415-555-2671" },
    {
      name: "Customer",
      phoneNumber: "+14155552671",
      email: "forged@example.com",
    },
  ];

  for (const pickupContact of invalidContacts) {
    assert.ok(
      validateOrderPayload({ ...validOrder, pickupContact }).errors.some(
        ({ field }) => field.startsWith("pickupContact"),
      ),
      JSON.stringify(pickupContact),
    );
  }

  assert.ok(
    fieldsFor({ ...validOrder, customerNote: 42 }).includes("customerNote"),
  );
  assert.ok(
    fieldsFor({
      ...validOrder,
      customerNote: "x".repeat(MAX_CUSTOMER_NOTE_LENGTH + 1),
    }).includes("customerNote"),
  );
});
