"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const { validateDishPayload } = require("./validate-dish");
const { validateMenuPayload } = require("./validate-menu");

const MENU_RECORD_ID = "MENU#CURRENT";
const PRIVATE_DISHES_RESOURCE = "/dishes/private";
const LEGACY_FULL_DISH_INFO_FIELD = "ragInfo";

let sharedDocumentClient;

const getDocumentClient = () => {
  if (!sharedDocumentClient) {
    sharedDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  return sharedDocumentClient;
};

const jsonResponse = (statusCode, payload, allowedOrigin) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

const errorResponse = (statusCode, code, message, allowedOrigin) =>
  jsonResponse(
    statusCode,
    {
      error: { code, message },
    },
    allowedOrigin,
  );

const getClaims = (event) =>
  event?.requestContext?.authorizer?.claims ||
  event?.requestContext?.authorizer?.jwt?.claims ||
  {};

const parseGroups = (claim) => {
  if (Array.isArray(claim)) {
    return claim;
  }

  if (typeof claim !== "string") {
    return [];
  }

  if (claim.startsWith("[")) {
    try {
      const parsed = JSON.parse(claim);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return claim.split(",").map((group) => group.trim()).filter(Boolean);
};

const isPrivateDishesRequest = (event) =>
  event?.resource === PRIVATE_DISHES_RESOURCE ||
  event?.requestContext?.resourcePath === PRIVATE_DISHES_RESOURCE;

const readStoredFullDishInfo = (item) =>
  item.fullDishInfo === undefined
    ? item[LEGACY_FULL_DISH_INFO_FIELD]
    : item.fullDishInfo;

const toStoredDish = (item) => ({
  id: item.id,
  category: item.category,
  name: item.name,
  description: item.description,
  price: item.price,
  ...(item.allergens === undefined ? {} : { allergens: item.allergens }),
  ...(readStoredFullDishInfo(item) === undefined
    ? {}
    : { fullDishInfo: readStoredFullDishInfo(item) }),
  ...(item.image === undefined ? {} : { image: item.image }),
  ...(item.availability === undefined
    ? {}
    : { availability: item.availability }),
});

const normalizeStoredMenuItems = (items) =>
  Array.isArray(items) ? items.map(toStoredDish) : items;

const toPublicDish = (item) => ({
  id: item.id,
  category: item.category,
  name: item.name,
  description: item.description,
  price: item.price,
  allergens: item.allergens,
  image: item.image,
  availability: item.availability,
});

const createGetDishesHandler = (dependencies = {}) => {
  const documentClient = dependencies.documentClient || getDocumentClient();
  const tableName = dependencies.tableName ?? process.env.DISHES_TABLE;
  const allowedOrigin =
    dependencies.allowedOrigin ?? process.env.CORS_ALLOWED_ORIGIN ?? "*";
  const adminGroupName =
    dependencies.adminGroupName ?? process.env.ADMIN_GROUP_NAME ?? "admin";
  const logger = dependencies.logger || console;

  return async (event = {}) => {
    const includePrivate = isPrivateDishesRequest(event);

    if (includePrivate) {
      const claims = getClaims(event);
      if (!claims.sub) {
        return errorResponse(
          401,
          "UNAUTHORIZED",
          "A valid Cognito token is required.",
          allowedOrigin,
        );
      }

      if (
        adminGroupName &&
        !parseGroups(claims["cognito:groups"]).includes(adminGroupName)
      ) {
        return errorResponse(
          403,
          "FORBIDDEN",
          `Membership in the ${adminGroupName} Cognito group is required.`,
          allowedOrigin,
        );
      }
    }

    if (!tableName) {
      logger.error("DISHES_TABLE is not configured");
      return jsonResponse(
        500,
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "The dishes could not be loaded.",
          },
        },
        allowedOrigin,
      );
    }

    const dishes = [];
    let exclusiveStartKey;

    try {
      const aggregateResponse = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { id: MENU_RECORD_ID },
          ConsistentRead: true,
        }),
      );

      if (aggregateResponse.Item) {
        const validation = validateMenuPayload({
          items: normalizeStoredMenuItems(aggregateResponse.Item.items),
        });

        if (validation.errors.length > 0) {
          const error = new Error("Invalid stored menu");
          error.name = "InvalidStoredMenuError";
          throw error;
        }

        return jsonResponse(
          200,
          includePrivate
            ? validation.value.items
            : validation.value.items.map(toPublicDish),
          allowedOrigin,
        );
      }

      do {
        const response = await documentClient.send(
          new ScanCommand({
            TableName: tableName,
            ProjectionExpression:
              "#id, #category, #name, #description, #price, #allergens, #fullDishInfo, #legacyFullDishInfo, #image, #availability",
            ExpressionAttributeNames: {
              "#id": "id",
              "#category": "category",
              "#name": "name",
              "#description": "description",
              "#price": "price",
              "#allergens": "allergens",
              "#fullDishInfo": "fullDishInfo",
              "#legacyFullDishInfo": LEGACY_FULL_DISH_INFO_FIELD,
              "#image": "image",
              "#availability": "availability",
            },
            ...(exclusiveStartKey
              ? { ExclusiveStartKey: exclusiveStartKey }
              : {}),
          }),
        );

        const page = (response.Items || [])
          .filter((item) => item.id !== MENU_RECORD_ID)
          .map((item) => {
            const validation = validateDishPayload(toStoredDish(item));
            if (validation.errors.length > 0) {
              const error = new Error("Invalid stored dish");
              error.name = "InvalidStoredDishError";
              throw error;
            }

            return validation.value;
          });

        dishes.push(...page);
        exclusiveStartKey =
          response.LastEvaluatedKey &&
          Object.keys(response.LastEvaluatedKey).length > 0
            ? response.LastEvaluatedKey
            : undefined;
      } while (exclusiveStartKey);

      dishes.sort((left, right) => {
        if (left.id < right.id) return -1;
        if (left.id > right.id) return 1;
        return 0;
      });

      return jsonResponse(
        200,
        includePrivate ? dishes : dishes.map(toPublicDish),
        allowedOrigin,
      );
    } catch (error) {
      logger.error("Could not load dishes", {
        errorName: error?.name,
        requestId: error?.$metadata?.requestId,
      });

      return jsonResponse(
        500,
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "The dishes could not be loaded.",
          },
        },
        allowedOrigin,
      );
    }
  };
};

exports.createGetDishesHandler = createGetDishesHandler;
exports.fn = createGetDishesHandler();
