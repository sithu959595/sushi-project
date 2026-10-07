"use strict";

const { randomUUID } = require("node:crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const MAX_BODY_BYTES = 8 * 1024;
const RESTAURANT_KEY = "RESTAURANT#SORA";
const ANNOUNCEMENT_KEY_PREFIX = "ANNOUNCEMENT#";
const ANNOUNCEMENT_ENTITY_TYPE = "ANNOUNCEMENT";
const ANNOUNCEMENT_TYPES = new Set([
  "GENERAL",
  "DISCOUNT",
  "CLOSURE",
  "EVENT",
]);
const ANNOUNCEMENT_STATUSES = new Set(["DRAFT", "PUBLISHED"]);
const ANNOUNCEMENT_ID_PATTERN =
  /^ann_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_FIELDS = new Set([
  "type",
  "title",
  "message",
  "promoCode",
  "status",
  "startsAt",
  "endsAt",
  "priority",
]);
const REQUIRED_CONTENT_FIELDS = [
  "type",
  "title",
  "message",
  "status",
  "startsAt",
  "endsAt",
  "priority",
];
const POST_FIELDS = CONTENT_FIELDS;
const PATCH_FIELDS = new Set([
  ...CONTENT_FIELDS,
  "expectedUpdatedAt",
]);
const DELETE_FIELDS = new Set(["expectedUpdatedAt"]);

let sharedDocumentClient;

const getDocumentClient = () => {
  if (!sharedDocumentClient) {
    sharedDocumentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({}),
    );
  }

  return sharedDocumentClient;
};

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const getClaims = (event) =>
  event?.requestContext?.authorizer?.claims ||
  event?.requestContext?.authorizer?.jwt?.claims ||
  {};

const parseGroups = (claim) => {
  if (Array.isArray(claim)) {
    return claim.map(String);
  }

  if (typeof claim !== "string" || !claim.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(claim);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // REST API Cognito authorizers commonly expose a comma-separated string.
  }

  return claim
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);
};

const jsonResponse = (statusCode, payload, allowedOrigin) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  },
  body: payload === undefined ? "" : JSON.stringify(payload),
});

const errorResponse = (
  statusCode,
  code,
  message,
  allowedOrigin,
  details,
) =>
  jsonResponse(
    statusCode,
    {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    },
    allowedOrigin,
  );

const requestMethod = (event) =>
  event?.httpMethod || event?.requestContext?.http?.method;

const parseRequestBody = (event) => {
  if (typeof event?.body !== "string") {
    return {
      error: {
        code: "INVALID_JSON",
        message: "The request body must be a JSON object.",
      },
    };
  }

  let body = event.body;
  if (event.isBase64Encoded) {
    body = Buffer.from(body, "base64").toString("utf8");
  }

  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return {
      error: {
        statusCode: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "The request body must not exceed 8 KiB.",
      },
    };
  }

  try {
    return { value: JSON.parse(body) };
  } catch {
    return {
      error: {
        code: "INVALID_JSON",
        message: "The request body contains invalid JSON.",
      },
    };
  }
};

const isCanonicalTimestamp = (value) => {
  if (typeof value !== "string") {
    return false;
  }

  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const validateExactFields = (payload, allowedFields) => {
  const errors = [];

  for (const field of Object.keys(payload)) {
    if (!allowedFields.has(field)) {
      errors.push({ field, message: "is not an allowed field" });
    }
  }

  return errors;
};

const validateAnnouncementContent = (payload, allowedFields) => {
  if (!isPlainObject(payload)) {
    return {
      errors: [{ field: "body", message: "must be a JSON object" }],
    };
  }

  const errors = validateExactFields(payload, allowedFields);

  for (const field of REQUIRED_CONTENT_FIELDS) {
    if (!Object.hasOwn(payload, field)) {
      errors.push({ field, message: "is required" });
    }
  }

  if (
    typeof payload.type !== "string" ||
    !ANNOUNCEMENT_TYPES.has(payload.type)
  ) {
    errors.push({
      field: "type",
      message: "must be one of: GENERAL, DISCOUNT, CLOSURE, EVENT",
    });
  }

  let title;
  if (typeof payload.title !== "string") {
    errors.push({ field: "title", message: "must be a string" });
  } else {
    title = payload.title.trim();
    if (!title) {
      errors.push({ field: "title", message: "must not be empty" });
    } else if (title.length > 100) {
      errors.push({
        field: "title",
        message: "must not exceed 100 characters",
      });
    }
  }

  let message;
  if (typeof payload.message !== "string") {
    errors.push({ field: "message", message: "must be a string" });
  } else {
    message = payload.message.trim();
    if (!message) {
      errors.push({
        field: "message",
        message: "must not be empty",
      });
    } else if (message.length > 1000) {
      errors.push({
        field: "message",
        message: "must not exceed 1000 characters",
      });
    }
  }

  let promoCode;
  if (Object.hasOwn(payload, "promoCode")) {
    if (payload.type !== "DISCOUNT") {
      errors.push({
        field: "promoCode",
        message: "is only allowed for DISCOUNT announcements",
      });
    }

    if (
      typeof payload.promoCode !== "string" ||
      !/^[A-Z0-9_-]{1,32}$/u.test(payload.promoCode)
    ) {
      errors.push({
        field: "promoCode",
        message:
          "must contain 1 to 32 uppercase letters, numbers, underscores, or hyphens",
      });
    } else {
      promoCode = payload.promoCode;
    }
  }

  if (
    typeof payload.status !== "string" ||
    !ANNOUNCEMENT_STATUSES.has(payload.status)
  ) {
    errors.push({
      field: "status",
      message: "must be one of: DRAFT, PUBLISHED",
    });
  }

  if (!isCanonicalTimestamp(payload.startsAt)) {
    errors.push({
      field: "startsAt",
      message: "must be a canonical UTC timestamp",
    });
  }

  if (!isCanonicalTimestamp(payload.endsAt)) {
    errors.push({
      field: "endsAt",
      message: "must be a canonical UTC timestamp",
    });
  }

  if (
    isCanonicalTimestamp(payload.startsAt) &&
    isCanonicalTimestamp(payload.endsAt) &&
    payload.startsAt >= payload.endsAt
  ) {
    errors.push({
      field: "endsAt",
      message: "must be after startsAt",
    });
  }

  if (
    !Number.isInteger(payload.priority) ||
    payload.priority < 0 ||
    payload.priority > 100
  ) {
    errors.push({
      field: "priority",
      message: "must be an integer between 0 and 100",
    });
  }

  return {
    errors,
    value: {
      type: payload.type,
      title,
      message,
      ...(promoCode === undefined ? {} : { promoCode }),
      status: payload.status,
      startsAt: payload.startsAt,
      endsAt: payload.endsAt,
      priority: payload.priority,
    },
  };
};

const validateExpectedUpdatedAt = (payload, errors) => {
  if (!Object.hasOwn(payload, "expectedUpdatedAt")) {
    errors.push({
      field: "expectedUpdatedAt",
      message: "is required",
    });
    return undefined;
  }

  if (!isCanonicalTimestamp(payload.expectedUpdatedAt)) {
    errors.push({
      field: "expectedUpdatedAt",
      message: "must be a canonical UTC timestamp",
    });
    return undefined;
  }

  return payload.expectedUpdatedAt;
};

const validatePatchRequest = (payload) => {
  const validation = validateAnnouncementContent(
    payload,
    PATCH_FIELDS,
  );
  if (!isPlainObject(payload)) {
    return validation;
  }

  const expectedUpdatedAt = validateExpectedUpdatedAt(
    payload,
    validation.errors,
  );
  return {
    errors: validation.errors,
    value: {
      ...validation.value,
      expectedUpdatedAt,
    },
  };
};

const validateDeleteRequest = (payload) => {
  if (!isPlainObject(payload)) {
    return {
      errors: [{ field: "body", message: "must be a JSON object" }],
    };
  }

  const errors = validateExactFields(payload, DELETE_FIELDS);
  const expectedUpdatedAt = validateExpectedUpdatedAt(payload, errors);
  return { errors, value: { expectedUpdatedAt } };
};

const toAdminAnnouncement = (item) => ({
  announcementId: item.announcementId,
  type: item.type,
  title: item.title,
  message: item.message,
  ...(item.promoCode === undefined
    ? {}
    : { promoCode: item.promoCode }),
  status: item.status,
  startsAt: item.startsAt,
  endsAt: item.endsAt,
  priority: item.priority,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  updatedBy: item.updatedBy,
});

const isConditionalCheckFailure = (error) =>
  error?.name === "ConditionalCheckFailedException";

const createManageAnnouncementsHandler = (dependencies = {}) => {
  const documentClient =
    dependencies.documentClient || getDocumentClient();
  const tableName =
    dependencies.tableName ?? process.env.RESTAURANT_CONTENT_TABLE;
  const allowedOrigin =
    dependencies.allowedOrigin ?? process.env.CORS_ALLOWED_ORIGIN ?? "*";
  const adminGroupName =
    dependencies.adminGroupName ?? process.env.ADMIN_GROUP_NAME ?? "admin";
  const createUuid = dependencies.randomUUID || randomUUID;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  return async (event = {}) => {
    const claims = getClaims(event);
    if (
      typeof claims.sub !== "string" ||
      !claims.sub.trim()
    ) {
      return errorResponse(
        401,
        "UNAUTHORIZED",
        "A valid Cognito token is required.",
        allowedOrigin,
      );
    }

    if (
      adminGroupName &&
      !parseGroups(claims["cognito:groups"]).includes(
        adminGroupName,
      )
    ) {
      return errorResponse(
        403,
        "FORBIDDEN",
        `Membership in the ${adminGroupName} Cognito group is required.`,
        allowedOrigin,
      );
    }

    if (!tableName) {
      logger.error("RESTAURANT_CONTENT_TABLE is not configured");
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The announcement could not be changed.",
        allowedOrigin,
      );
    }

    const method = requestMethod(event);
    if (!["POST", "PATCH", "DELETE"].includes(method)) {
      return errorResponse(
        405,
        "METHOD_NOT_ALLOWED",
        "This endpoint only supports POST, PATCH, and DELETE requests.",
        allowedOrigin,
      );
    }

    let announcementId;
    if (method !== "POST") {
      announcementId = event?.pathParameters?.announcementId;
      if (
        typeof announcementId !== "string" ||
        !ANNOUNCEMENT_ID_PATTERN.test(announcementId)
      ) {
        return errorResponse(
          400,
          "INVALID_ANNOUNCEMENT_ID",
          "The announcement ID is invalid.",
          allowedOrigin,
        );
      }
    }

    const parsedBody = parseRequestBody(event);
    if (parsedBody.error) {
      return errorResponse(
        parsedBody.error.statusCode || 400,
        parsedBody.error.code,
        parsedBody.error.message,
        allowedOrigin,
      );
    }

    const validation =
      method === "POST"
        ? validateAnnouncementContent(parsedBody.value, POST_FIELDS)
        : method === "PATCH"
          ? validatePatchRequest(parsedBody.value)
          : validateDeleteRequest(parsedBody.value);

    if (validation.errors.length > 0) {
      return errorResponse(
        422,
        "VALIDATION_ERROR",
        "The announcement data is invalid.",
        allowedOrigin,
        validation.errors,
      );
    }

    const administratorId = claims.sub.trim();

    try {
      if (method === "POST") {
        announcementId = `ann_${createUuid()}`;
        if (!ANNOUNCEMENT_ID_PATTERN.test(announcementId)) {
          throw new Error(
            "The UUID generator returned an invalid announcement ID",
          );
        }

        const timestampValue = now();
        const timestamp =
          timestampValue instanceof Date
            ? timestampValue.toISOString()
            : new Date(timestampValue).toISOString();
        const item = {
          pk: RESTAURANT_KEY,
          sk: `${ANNOUNCEMENT_KEY_PREFIX}${announcementId}`,
          entityType: ANNOUNCEMENT_ENTITY_TYPE,
          announcementId,
          ...validation.value,
          createdAt: timestamp,
          updatedAt: timestamp,
          updatedBy: administratorId,
        };

        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression:
              "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
            ExpressionAttributeNames: {
              "#pk": "pk",
              "#sk": "sk",
            },
          }),
        );

        return jsonResponse(
          201,
          { announcement: toAdminAnnouncement(item) },
          allowedOrigin,
        );
      }

      const key = {
        pk: RESTAURANT_KEY,
        sk: `${ANNOUNCEMENT_KEY_PREFIX}${announcementId}`,
      };

      if (method === "DELETE") {
        try {
          await documentClient.send(
            new DeleteCommand({
              TableName: tableName,
              Key: key,
              ConditionExpression:
                "#entityType = :announcementType AND " +
                "#announcementId = :announcementId AND " +
                "#updatedAt = :expectedUpdatedAt",
              ExpressionAttributeNames: {
                "#entityType": "entityType",
                "#announcementId": "announcementId",
                "#updatedAt": "updatedAt",
              },
              ExpressionAttributeValues: {
                ":announcementType": ANNOUNCEMENT_ENTITY_TYPE,
                ":announcementId": announcementId,
                ":expectedUpdatedAt":
                  validation.value.expectedUpdatedAt,
              },
            }),
          );
        } catch (error) {
          if (isConditionalCheckFailure(error)) {
            return errorResponse(
              409,
              "ANNOUNCEMENT_CONFLICT",
              "The announcement has changed or no longer exists. Refresh and try again.",
              allowedOrigin,
            );
          }
          throw error;
        }

        return jsonResponse(204, undefined, allowedOrigin);
      }

      const timestampValue = now();
      const timestampDate =
        timestampValue instanceof Date
          ? timestampValue
          : new Date(timestampValue);
      const expectedUpdatedAtDate = new Date(
        validation.value.expectedUpdatedAt,
      );
      const updatedAt =
        timestampDate.getTime() > expectedUpdatedAtDate.getTime()
          ? timestampDate.toISOString()
          : new Date(
              expectedUpdatedAtDate.getTime() + 1,
            ).toISOString();
      const expressionAttributeNames = {
        "#entityType": "entityType",
        "#announcementId": "announcementId",
        "#type": "type",
        "#title": "title",
        "#message": "message",
        "#promoCode": "promoCode",
        "#status": "status",
        "#startsAt": "startsAt",
        "#endsAt": "endsAt",
        "#priority": "priority",
        "#updatedAt": "updatedAt",
        "#updatedBy": "updatedBy",
      };
      const expressionAttributeValues = {
        ":announcementType": ANNOUNCEMENT_ENTITY_TYPE,
        ":announcementId": announcementId,
        ":type": validation.value.type,
        ":title": validation.value.title,
        ":message": validation.value.message,
        ":status": validation.value.status,
        ":startsAt": validation.value.startsAt,
        ":endsAt": validation.value.endsAt,
        ":priority": validation.value.priority,
        ":updatedAt": updatedAt,
        ":updatedBy": administratorId,
        ":expectedUpdatedAt": validation.value.expectedUpdatedAt,
      };
      const setExpressions = [
        "#type = :type",
        "#title = :title",
        "#message = :message",
        "#status = :status",
        "#startsAt = :startsAt",
        "#endsAt = :endsAt",
        "#priority = :priority",
        "#updatedAt = :updatedAt",
        "#updatedBy = :updatedBy",
      ];
      let removeExpression = "";

      if (validation.value.promoCode === undefined) {
        removeExpression = " REMOVE #promoCode";
      } else {
        setExpressions.push("#promoCode = :promoCode");
        expressionAttributeValues[":promoCode"] =
          validation.value.promoCode;
      }

      let response;
      try {
        response = await documentClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: key,
            UpdateExpression:
              `SET ${setExpressions.join(", ")}` + removeExpression,
            ConditionExpression:
              "#entityType = :announcementType AND " +
              "#announcementId = :announcementId AND " +
              "#updatedAt = :expectedUpdatedAt",
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "ALL_NEW",
          }),
        );
      } catch (error) {
        if (isConditionalCheckFailure(error)) {
          return errorResponse(
            409,
            "ANNOUNCEMENT_CONFLICT",
            "The announcement has changed or no longer exists. Refresh and try again.",
            allowedOrigin,
          );
        }
        throw error;
      }

      if (
        !isPlainObject(response?.Attributes) ||
        response.Attributes.entityType !== ANNOUNCEMENT_ENTITY_TYPE ||
        response.Attributes.announcementId !== announcementId
      ) {
        throw new Error(
          "DynamoDB returned an invalid updated announcement",
        );
      }

      return jsonResponse(
        200,
        { announcement: toAdminAnnouncement(response.Attributes) },
        allowedOrigin,
      );
    } catch (error) {
      if (method === "POST" && isConditionalCheckFailure(error)) {
        logger.error("Could not allocate a unique announcement ID", {
          errorName: error?.name,
          requestId: error?.$metadata?.requestId,
        });
      } else {
        logger.error("Could not change announcement", {
          errorName: error?.name,
          requestId: error?.$metadata?.requestId,
        });
      }

      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The announcement could not be changed.",
        allowedOrigin,
      );
    }
  };
};

exports.ANNOUNCEMENT_ENTITY_TYPE = ANNOUNCEMENT_ENTITY_TYPE;
exports.ANNOUNCEMENT_ID_PATTERN = ANNOUNCEMENT_ID_PATTERN;
exports.ANNOUNCEMENT_KEY_PREFIX = ANNOUNCEMENT_KEY_PREFIX;
exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
exports.RESTAURANT_KEY = RESTAURANT_KEY;
exports.createManageAnnouncementsHandler =
  createManageAnnouncementsHandler;
exports.isCanonicalTimestamp = isCanonicalTimestamp;
exports.toAdminAnnouncement = toAdminAnnouncement;
exports.validateAnnouncementContent = validateAnnouncementContent;
exports.validateDeleteRequest = validateDeleteRequest;
exports.validatePatchRequest = validatePatchRequest;
exports.fn = createManageAnnouncementsHandler();
