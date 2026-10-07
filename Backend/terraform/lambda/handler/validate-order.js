"use strict";

const MIN_ORDER_ITEMS = 1;
const MAX_ORDER_ITEMS = 50;
const MAX_ITEM_QUANTITY = 20;
const MAX_TOTAL_QUANTITY = 100;
const MAX_CUSTOMER_NAME_LENGTH = 100;
const MAX_CUSTOMER_NOTE_LENGTH = 500;
const MIN_CLIENT_REQUEST_ID_LENGTH = 8;
const MAX_CLIENT_REQUEST_ID_LENGTH = 100;
const MAX_DISH_ID_LENGTH = 100;

const TOP_LEVEL_FIELDS = new Set([
  "clientRequestId",
  "items",
  "fulfillment",
  "pickupContact",
  "customerNote",
]);
const ITEM_FIELDS = new Set(["dishId", "quantity"]);
const PICKUP_CONTACT_FIELDS = new Set(["name", "phoneNumber"]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/;
const PHONE_NUMBER_PATTERN = /^\+[1-9]\d{7,14}$/;

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const addError = (errors, field, message) => {
  errors.push({ field, message });
};

const rejectUnknownFields = (value, allowedFields, prefix, errors) => {
  Object.keys(value).forEach((field) => {
    if (!allowedFields.has(field)) {
      addError(
        errors,
        prefix ? `${prefix}.${field}` : field,
        "is not an allowed field",
      );
    }
  });
};

const readRequiredString = (value, field, maxLength, errors) => {
  if (typeof value !== "string") {
    addError(errors, field, "must be a string");
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    addError(errors, field, "must not be empty");
    return undefined;
  }

  if (normalized.length > maxLength) {
    addError(errors, field, `must not exceed ${maxLength} characters`);
    return undefined;
  }

  return normalized;
};

const readClientRequestId = (payload, errors) => {
  const value = readRequiredString(
    payload.clientRequestId,
    "clientRequestId",
    MAX_CLIENT_REQUEST_ID_LENGTH,
    errors,
  );

  if (value && !SAFE_ID_PATTERN.test(value)) {
    addError(
      errors,
      "clientRequestId",
      "must contain only letters, numbers, hyphens, or underscores",
    );
    return undefined;
  }

  if (value && value.length < MIN_CLIENT_REQUEST_ID_LENGTH) {
    addError(
      errors,
      "clientRequestId",
      `must contain at least ${MIN_CLIENT_REQUEST_ID_LENGTH} characters`,
    );
    return undefined;
  }

  return value;
};

const readItems = (payload, errors) => {
  if (!Array.isArray(payload.items)) {
    addError(errors, "items", "must be an array");
    return [];
  }

  if (
    payload.items.length < MIN_ORDER_ITEMS ||
    payload.items.length > MAX_ORDER_ITEMS
  ) {
    addError(
      errors,
      "items",
      `must contain between ${MIN_ORDER_ITEMS} and ${MAX_ORDER_ITEMS} dishes`,
    );
  }

  const seenDishIds = new Set();
  let totalQuantity = 0;

  const items = payload.items.map((item, index) => {
    const prefix = `items[${index}]`;

    if (!isPlainObject(item)) {
      addError(errors, prefix, "must be a JSON object");
      return {};
    }

    rejectUnknownFields(item, ITEM_FIELDS, prefix, errors);

    const dishId = readRequiredString(
      item.dishId,
      `${prefix}.dishId`,
      MAX_DISH_ID_LENGTH,
      errors,
    );

    let normalizedDishId = dishId;
    if (dishId && !SAFE_ID_PATTERN.test(dishId)) {
      addError(
        errors,
        `${prefix}.dishId`,
        "must contain only letters, numbers, hyphens, or underscores",
      );
      normalizedDishId = undefined;
    }

    if (normalizedDishId) {
      if (seenDishIds.has(normalizedDishId)) {
        addError(errors, `${prefix}.dishId`, "must be unique within the order");
      } else {
        seenDishIds.add(normalizedDishId);
      }
    }

    let quantity;
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > MAX_ITEM_QUANTITY
    ) {
      addError(
        errors,
        `${prefix}.quantity`,
        `must be an integer between 1 and ${MAX_ITEM_QUANTITY}`,
      );
    } else {
      quantity = item.quantity;
      totalQuantity += quantity;
    }

    return { dishId: normalizedDishId, quantity };
  });

  if (totalQuantity > MAX_TOTAL_QUANTITY) {
    addError(
      errors,
      "items",
      `must not contain more than ${MAX_TOTAL_QUANTITY} total dishes`,
    );
  }

  return items;
};

const readFulfillment = (payload, errors) => {
  const value = readRequiredString(
    payload.fulfillment,
    "fulfillment",
    20,
    errors,
  );

  if (value && value !== "pickup") {
    addError(errors, "fulfillment", "must be pickup");
    return undefined;
  }

  return value;
};

const readPickupContact = (payload, errors) => {
  if (!isPlainObject(payload.pickupContact)) {
    addError(errors, "pickupContact", "must be a JSON object");
    return {};
  }

  rejectUnknownFields(
    payload.pickupContact,
    PICKUP_CONTACT_FIELDS,
    "pickupContact",
    errors,
  );

  const name = readRequiredString(
    payload.pickupContact.name,
    "pickupContact.name",
    MAX_CUSTOMER_NAME_LENGTH,
    errors,
  );
  const phoneNumber = readRequiredString(
    payload.pickupContact.phoneNumber,
    "pickupContact.phoneNumber",
    16,
    errors,
  );

  if (phoneNumber && !PHONE_NUMBER_PATTERN.test(phoneNumber)) {
    addError(
      errors,
      "pickupContact.phoneNumber",
      "must be an international phone number such as +14155552671",
    );
  }

  return { name, phoneNumber };
};

const readCustomerNote = (payload, errors) => {
  if (payload.customerNote === undefined) {
    return "";
  }

  if (typeof payload.customerNote !== "string") {
    addError(errors, "customerNote", "must be a string");
    return undefined;
  }

  const value = payload.customerNote.trim();
  if (value.length > MAX_CUSTOMER_NOTE_LENGTH) {
    addError(
      errors,
      "customerNote",
      `must not exceed ${MAX_CUSTOMER_NOTE_LENGTH} characters`,
    );
    return undefined;
  }

  return value;
};

const validateOrderPayload = (payload) => {
  const errors = [];

  if (!isPlainObject(payload)) {
    return {
      errors: [{ field: "body", message: "must be a JSON object" }],
    };
  }

  rejectUnknownFields(payload, TOP_LEVEL_FIELDS, "", errors);

  const value = {
    clientRequestId: readClientRequestId(payload, errors),
    items: readItems(payload, errors),
    fulfillment: readFulfillment(payload, errors),
    pickupContact: readPickupContact(payload, errors),
    customerNote: readCustomerNote(payload, errors),
  };

  return { errors, value };
};

exports.MAX_CLIENT_REQUEST_ID_LENGTH = MAX_CLIENT_REQUEST_ID_LENGTH;
exports.MAX_CUSTOMER_NAME_LENGTH = MAX_CUSTOMER_NAME_LENGTH;
exports.MAX_CUSTOMER_NOTE_LENGTH = MAX_CUSTOMER_NOTE_LENGTH;
exports.MAX_ITEM_QUANTITY = MAX_ITEM_QUANTITY;
exports.MAX_ORDER_ITEMS = MAX_ORDER_ITEMS;
exports.MAX_TOTAL_QUANTITY = MAX_TOTAL_QUANTITY;
exports.MIN_CLIENT_REQUEST_ID_LENGTH = MIN_CLIENT_REQUEST_ID_LENGTH;
exports.MIN_ORDER_ITEMS = MIN_ORDER_ITEMS;
exports.validateOrderPayload = validateOrderPayload;
