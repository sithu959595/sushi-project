"use strict";

const { validateDishPayload } = require("./validate-dish");

const MIN_MENU_ITEMS = 1;
const MAX_MENU_ITEMS = 50;
const ALLOWED_FIELDS = new Set(["items"]);

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const validateMenuPayload = (payload) => {
  const errors = [];

  if (!isPlainObject(payload)) {
    return {
      errors: [{ field: "body", message: "must be a JSON object" }],
    };
  }

  Object.keys(payload).forEach((field) => {
    if (!ALLOWED_FIELDS.has(field)) {
      errors.push({ field, message: "is not an allowed field" });
    }
  });

  if (!Array.isArray(payload.items)) {
    errors.push({ field: "items", message: "must be an array" });
    return { errors };
  }

  if (
    payload.items.length < MIN_MENU_ITEMS ||
    payload.items.length > MAX_MENU_ITEMS
  ) {
    errors.push({
      field: "items",
      message: `must contain between ${MIN_MENU_ITEMS} and ${MAX_MENU_ITEMS} dishes`,
    });
  }

  const seenIds = new Set();
  const items = payload.items.map((item, index) => {
    const validation = validateDishPayload(item);

    validation.errors.forEach(({ field, message }) => {
      errors.push({
        field: field === "body" ? `items[${index}]` : `items[${index}].${field}`,
        message,
      });
    });

    const id = validation.value?.id;
    if (id) {
      if (seenIds.has(id)) {
        errors.push({
          field: `items[${index}].id`,
          message: "must be unique within the menu",
        });
      } else {
        seenIds.add(id);
      }
    }

    return validation.value;
  });

  return { errors, value: { items } };
};

exports.MAX_MENU_ITEMS = MAX_MENU_ITEMS;
exports.MIN_MENU_ITEMS = MIN_MENU_ITEMS;
exports.validateMenuPayload = validateMenuPayload;
