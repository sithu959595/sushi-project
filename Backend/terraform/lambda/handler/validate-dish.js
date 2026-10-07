"use strict";

const ALLOWED_FIELDS = new Set([
  "id",
  "category",
  "name",
  "description",
  "price",
  "allergens",
  "fullDishInfo",
  "image",
  "availability",
]);
const ALLERGEN_TYPES = [
  "fish",
  "shellfish",
  "milk",
  "egg",
  "peanut",
  "tree-nuts",
  "wheat",
  "soy",
  "sesame",
];
const LEGACY_ALLERGEN_ALIASES = new Map([["gluten", "wheat"]]);
const ALLOWED_ALLERGENS = new Set([
  ...ALLERGEN_TYPES,
  ...LEGACY_ALLERGEN_ALIASES.keys(),
]);
const AVAILABILITY_TYPES = ["available", "out"];
const ALLOWED_AVAILABILITY = new Set(AVAILABILITY_TYPES);
const DEFAULT_AVAILABILITY = "available";
const MAX_FULL_DISH_INFO_LENGTH = 4000;
const IMAGE_FIELDS = new Set(["key", "alt", "width", "height"]);
const MAX_IMAGE_ALT_LENGTH = 250;
const MAX_IMAGE_DIMENSION = 10_000;
const IMAGE_KEY_PATTERN =
  /^dishes\/([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*)\/([A-Za-z0-9][A-Za-z0-9_-]{0,199})\.(jpg|jpeg|png|webp)$/;

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const addError = (errors, field, message) => {
  errors.push({ field, message });
};

const readRequiredString = (payload, field, maxLength, errors) => {
  const value = payload[field];

  if (typeof value !== "string") {
    addError(errors, field, "must be a string");
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    addError(errors, field, "must not be empty");
    return undefined;
  }

  if (trimmed.length > maxLength) {
    addError(errors, field, `must not exceed ${maxLength} characters`);
    return undefined;
  }

  return trimmed;
};

const readId = (payload, errors) => {
  const id = readRequiredString(payload, "id", 100, errors);
  if (id && !/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(id)) {
    addError(
      errors,
      "id",
      "must contain only letters, numbers, hyphens, or underscores",
    );
    return undefined;
  }

  return id;
};

const readPrice = (payload, errors) => {
  if (typeof payload.price !== "string") {
    addError(errors, "price", "must be a string");
    return undefined;
  }

  const price = payload.price.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(price);
  if (!match) {
    addError(
      errors,
      "price",
      "must be a non-negative decimal string with at most 2 decimal places",
    );
    return undefined;
  }

  const cents =
    Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 10_000_000) {
    addError(errors, "price", "must not exceed 100000.00");
    return undefined;
  }

  return price;
};

const readAllergens = (payload, errors) => {
  if (payload.allergens === undefined) {
    return [];
  }

  if (!Array.isArray(payload.allergens)) {
    addError(errors, "allergens", "must be an array");
    return [];
  }

  const selectedAllergens = new Set();
  const seenInputAllergens = new Set();
  payload.allergens.forEach((allergen, index) => {
    if (typeof allergen !== "string") {
      addError(errors, `allergens[${index}]`, "must be a string");
      return;
    }

    if (!ALLOWED_ALLERGENS.has(allergen)) {
      addError(
        errors,
        `allergens[${index}]`,
        `must be one of: ${ALLERGEN_TYPES.join(", ")}`,
      );
      return;
    }

    if (seenInputAllergens.has(allergen)) {
      addError(errors, `allergens[${index}]`, "must not be duplicated");
      return;
    }

    seenInputAllergens.add(allergen);
    selectedAllergens.add(
      LEGACY_ALLERGEN_ALIASES.get(allergen) || allergen,
    );
  });

  return ALLERGEN_TYPES.filter((allergen) => selectedAllergens.has(allergen));
};

const readFullDishInfo = (payload, errors) => {
  if (payload.fullDishInfo === undefined) {
    return "";
  }

  if (typeof payload.fullDishInfo !== "string") {
    addError(errors, "fullDishInfo", "must be a string");
    return "";
  }

  const fullDishInfo = payload.fullDishInfo.trim();
  if (fullDishInfo.length > MAX_FULL_DISH_INFO_LENGTH) {
    addError(
      errors,
      "fullDishInfo",
      `must not exceed ${MAX_FULL_DISH_INFO_LENGTH} characters`,
    );
    return "";
  }

  return fullDishInfo;
};

const readAvailability = (payload, errors) => {
  if (payload.availability === undefined) {
    return DEFAULT_AVAILABILITY;
  }

  if (typeof payload.availability !== "string") {
    addError(errors, "availability", "must be a string");
    return DEFAULT_AVAILABILITY;
  }

  const availability = payload.availability.trim().toLowerCase();
  if (!ALLOWED_AVAILABILITY.has(availability)) {
    addError(
      errors,
      "availability",
      `must be one of: ${AVAILABILITY_TYPES.join(", ")}`,
    );
    return DEFAULT_AVAILABILITY;
  }

  return availability;
};

const readImageDimension = (image, field, errors) => {
  const value = image[field];

  if (!Number.isInteger(value) || value <= 0 || value > MAX_IMAGE_DIMENSION) {
    addError(
      errors,
      `image.${field}`,
      `must be a positive integer no greater than ${MAX_IMAGE_DIMENSION}`,
    );
    return undefined;
  }

  return value;
};

const readImage = (payload, dishId, errors) => {
  const image = payload.image;
  if (!isPlainObject(image)) {
    addError(errors, "image", "must be a JSON object");
    return undefined;
  }

  Object.keys(image).forEach((field) => {
    if (!IMAGE_FIELDS.has(field)) {
      addError(errors, `image.${field}`, "is not an allowed field");
    }
  });

  let key;
  if (typeof image.key !== "string") {
    addError(errors, "image.key", "must be a string");
  } else {
    const candidate = image.key.trim();
    const match = IMAGE_KEY_PATTERN.exec(candidate);

    if (!match) {
      addError(
        errors,
        "image.key",
        "must use the format dishes/<dish-id>/<unique-filename>.(jpg|jpeg|png|webp)",
      );
    } else if (dishId && match[1] !== dishId) {
      addError(errors, "image.key", "must contain the same dish id as id");
    } else {
      key = candidate;
    }
  }

  let alt;
  if (typeof image.alt !== "string") {
    addError(errors, "image.alt", "must be a string");
  } else {
    const candidate = image.alt.trim();
    if (candidate.length > MAX_IMAGE_ALT_LENGTH) {
      addError(
        errors,
        "image.alt",
        `must not exceed ${MAX_IMAGE_ALT_LENGTH} characters`,
      );
    } else {
      alt = candidate;
    }
  }

  return {
    key,
    alt,
    width: readImageDimension(image, "width", errors),
    height: readImageDimension(image, "height", errors),
  };
};

const validateDishPayload = (payload) => {
  const errors = [];
  if (!isPlainObject(payload)) {
    return {
      errors: [{ field: "body", message: "must be a JSON object" }],
    };
  }

  Object.keys(payload).forEach((field) => {
    if (!ALLOWED_FIELDS.has(field)) {
      addError(errors, field, "is not an allowed field");
    }
  });

  const value = {
    id: readId(payload, errors),
    category: readRequiredString(payload, "category", 50, errors),
    name: readRequiredString(payload, "name", 120, errors),
    description: readRequiredString(payload, "description", 1000, errors),
    price: readPrice(payload, errors),
    availability: readAvailability(payload, errors),
  };

  if (payload.allergens !== undefined) {
    value.allergens = readAllergens(payload, errors);
  }

  if (payload.fullDishInfo !== undefined) {
    value.fullDishInfo = readFullDishInfo(payload, errors);
  }

  if (payload.image !== undefined) {
    value.image = readImage(payload, value.id, errors);
  }

  return { errors, value };
};

exports.ALLERGEN_TYPES = ALLERGEN_TYPES;
exports.AVAILABILITY_TYPES = AVAILABILITY_TYPES;
exports.DEFAULT_AVAILABILITY = DEFAULT_AVAILABILITY;
exports.MAX_IMAGE_ALT_LENGTH = MAX_IMAGE_ALT_LENGTH;
exports.MAX_IMAGE_DIMENSION = MAX_IMAGE_DIMENSION;
exports.MAX_FULL_DISH_INFO_LENGTH = MAX_FULL_DISH_INFO_LENGTH;
exports.validateDishPayload = validateDishPayload;
