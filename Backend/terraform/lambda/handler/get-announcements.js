"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");

const RESTAURANT_KEY = "RESTAURANT#SORA";
const ANNOUNCEMENT_KEY_PREFIX = "ANNOUNCEMENT#";
const ANNOUNCEMENT_ENTITY_TYPE = "ANNOUNCEMENT";
const PRIVATE_ANNOUNCEMENTS_RESOURCE = "/announcements/private";
const ANNOUNCEMENT_TYPES = new Set([
  "GENERAL",
  "DISCOUNT",
  "CLOSURE",
  "EVENT",
]);
const ANNOUNCEMENT_STATUSES = new Set(["DRAFT", "PUBLISHED"]);

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

const requestMethod = (event) =>
  event?.httpMethod || event?.requestContext?.http?.method;

const isPrivateRequest = (event) => {
  const paths = [
    event?.resource,
    event?.requestContext?.resourcePath,
    event?.path,
    event?.rawPath,
  ];

  return paths.some(
    (path) =>
      typeof path === "string" &&
      (path === PRIVATE_ANNOUNCEMENTS_RESOURCE ||
        path.endsWith(PRIVATE_ANNOUNCEMENTS_RESOURCE)),
  );
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

const isValidStoredAnnouncement = (item) =>
  isPlainObject(item) &&
  item.pk === RESTAURANT_KEY &&
  typeof item.sk === "string" &&
  item.sk === `${ANNOUNCEMENT_KEY_PREFIX}${item.announcementId}` &&
  item.entityType === ANNOUNCEMENT_ENTITY_TYPE &&
  /^ann_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    item.announcementId,
  ) &&
  ANNOUNCEMENT_TYPES.has(item.type) &&
  typeof item.title === "string" &&
  item.title.length > 0 &&
  item.title.length <= 100 &&
  typeof item.message === "string" &&
  item.message.length > 0 &&
  item.message.length <= 1000 &&
  (item.promoCode === undefined ||
    (item.type === "DISCOUNT" &&
      typeof item.promoCode === "string" &&
      /^[A-Z0-9_-]{1,32}$/u.test(item.promoCode))) &&
  ANNOUNCEMENT_STATUSES.has(item.status) &&
  isCanonicalTimestamp(item.startsAt) &&
  isCanonicalTimestamp(item.endsAt) &&
  item.startsAt < item.endsAt &&
  Number.isInteger(item.priority) &&
  item.priority >= 0 &&
  item.priority <= 100 &&
  isCanonicalTimestamp(item.createdAt) &&
  isCanonicalTimestamp(item.updatedAt) &&
  typeof item.updatedBy === "string" &&
  item.updatedBy.length > 0;

const toAnnouncement = (item, includeAdministrator) => ({
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
  ...(includeAdministrator ? { updatedBy: item.updatedBy } : {}),
});

const comparePublicAnnouncements = (left, right) =>
  right.priority - left.priority ||
  right.startsAt.localeCompare(left.startsAt) ||
  left.announcementId.localeCompare(right.announcementId);

const compareAdminAnnouncements = (left, right) =>
  right.updatedAt.localeCompare(left.updatedAt) ||
  left.announcementId.localeCompare(right.announcementId);

const createGetAnnouncementsHandler = (dependencies = {}) => {
  const documentClient =
    dependencies.documentClient || getDocumentClient();
  const tableName =
    dependencies.tableName ?? process.env.RESTAURANT_CONTENT_TABLE;
  const allowedOrigin =
    dependencies.allowedOrigin ?? process.env.CORS_ALLOWED_ORIGIN ?? "*";
  const adminGroupName =
    dependencies.adminGroupName ?? process.env.ADMIN_GROUP_NAME ?? "admin";
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  return async (event = {}) => {
    const method = requestMethod(event);
    if (method && method !== "GET") {
      return errorResponse(
        405,
        "METHOD_NOT_ALLOWED",
        "This endpoint only supports GET requests.",
        allowedOrigin,
      );
    }

    const includePrivate = isPrivateRequest(event);
    if (includePrivate) {
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
    }

    if (!tableName) {
      logger.error("RESTAURANT_CONTENT_TABLE is not configured");
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The announcements could not be loaded.",
        allowedOrigin,
      );
    }

    try {
      const storedAnnouncements = [];
      let exclusiveStartKey;

      do {
        const response = await documentClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression:
              "#pk = :restaurant AND begins_with(#sk, :announcementPrefix)",
            ExpressionAttributeNames: {
              "#pk": "pk",
              "#sk": "sk",
            },
            ExpressionAttributeValues: {
              ":restaurant": RESTAURANT_KEY,
              ":announcementPrefix": ANNOUNCEMENT_KEY_PREFIX,
            },
            ConsistentRead: true,
            ...(exclusiveStartKey
              ? { ExclusiveStartKey: exclusiveStartKey }
              : {}),
          }),
        );

        storedAnnouncements.push(...(response.Items || []));
        exclusiveStartKey =
          response.LastEvaluatedKey &&
          Object.keys(response.LastEvaluatedKey).length > 0
            ? response.LastEvaluatedKey
            : undefined;
      } while (exclusiveStartKey);

      let announcements = storedAnnouncements
        .filter(isValidStoredAnnouncement)
        .map((item) => toAnnouncement(item, includePrivate));

      if (includePrivate) {
        announcements.sort(compareAdminAnnouncements);
      } else {
        const currentDate = now();
        const currentTimestamp =
          currentDate instanceof Date
            ? currentDate.toISOString()
            : new Date(currentDate).toISOString();

        announcements = announcements
          .filter(
            (announcement) =>
              announcement.status === "PUBLISHED" &&
              announcement.startsAt <= currentTimestamp &&
              currentTimestamp < announcement.endsAt,
          )
          .sort(comparePublicAnnouncements);
      }

      return jsonResponse(
        200,
        { announcements },
        allowedOrigin,
      );
    } catch (error) {
      logger.error("Could not load announcements", {
        errorName: error?.name,
        requestId: error?.$metadata?.requestId,
      });

      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "The announcements could not be loaded.",
        allowedOrigin,
      );
    }
  };
};

exports.ANNOUNCEMENT_ENTITY_TYPE = ANNOUNCEMENT_ENTITY_TYPE;
exports.ANNOUNCEMENT_KEY_PREFIX = ANNOUNCEMENT_KEY_PREFIX;
exports.PRIVATE_ANNOUNCEMENTS_RESOURCE =
  PRIVATE_ANNOUNCEMENTS_RESOURCE;
exports.RESTAURANT_KEY = RESTAURANT_KEY;
exports.compareAdminAnnouncements = compareAdminAnnouncements;
exports.comparePublicAnnouncements = comparePublicAnnouncements;
exports.createGetAnnouncementsHandler = createGetAnnouncementsHandler;
exports.isValidStoredAnnouncement = isValidStoredAnnouncement;
exports.toAnnouncement = toAnnouncement;
exports.fn = createGetAnnouncementsHandler();
