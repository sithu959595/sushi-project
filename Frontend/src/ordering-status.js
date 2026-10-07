export const MAX_ORDERING_STATUS_MESSAGE_LENGTH = 300;

export const DEFAULT_ORDERING_PAUSED_MESSAGE =
  "Online ordering is temporarily paused.";

export const isOrderingActionBlocked = ({
  apiConfigured,
  requestState,
  acceptingOrders,
}) =>
  Boolean(
    apiConfigured &&
      (requestState !== "ready" || acceptingOrders !== true),
  );

const normalizeOptionalText = (value, fieldName) => {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value !== "string") {
    throw new Error(`The ordering status API returned an invalid ${fieldName}.`);
  }

  return value.trim();
};

export const normalizeOrderingStatus = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The ordering status API returned an invalid response.");
  }

  if (typeof value.acceptingOrders !== "boolean") {
    throw new Error(
      "The ordering status API returned an invalid acceptingOrders value.",
    );
  }

  const message = normalizeOptionalText(value.message, "message");
  if (!value.acceptingOrders && !message) {
    throw new Error(
      "The ordering status API returned a paused status without a message.",
    );
  }

  if (message.length > MAX_ORDERING_STATUS_MESSAGE_LENGTH) {
    throw new Error("The ordering status API returned a message that is too long.");
  }

  return {
    acceptingOrders: value.acceptingOrders,
    message,
    updatedAt: normalizeOptionalText(value.updatedAt, "updatedAt"),
    updatedBy: normalizeOptionalText(value.updatedBy, "updatedBy"),
  };
};

export const getOrderingPausedMessage = (message) =>
  typeof message === "string" && message.trim()
    ? message.trim()
    : DEFAULT_ORDERING_PAUSED_MESSAGE;
