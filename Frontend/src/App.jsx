import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
} from "amazon-cognito-identity-js";
import sushiHero from "./assets/sushi-hero.jpg";
import sushiHeroMobile from "./assets/sushi-hero-mobile.jpg";
import {
  MAX_ORDERING_STATUS_MESSAGE_LENGTH,
  getOrderingPausedMessage,
  isOrderingActionBlocked,
  normalizeOrderingStatus,
} from "./ordering-status.js";
import "./App.css";

const initialSignInValues = {
  email: "",
  password: "",
};

const initialSignUpValues = {
  fullName: "",
  phoneNumber: "",
  email: "",
  password: "",
  confirmPassword: "",
};

const initialConfirmationValues = {
  email: "",
  code: "",
};

const initialPasswordResetValues = {
  email: "",
  code: "",
  password: "",
  confirmPassword: "",
};

const PASSWORD_RESET_CODE_MESSAGE =
  "If an eligible account exists for that email, a password reset code has been sent.";

const initialPickupValues = {
  name: "",
  phoneNumber: "",
  note: "",
};

const ALLERGEN_OPTIONS = [
  { value: "fish", label: "Fish" },
  { value: "shellfish", label: "Shellfish" },
  { value: "milk", label: "Milk" },
  { value: "egg", label: "Egg" },
  { value: "peanut", label: "Peanut" },
  { value: "tree-nuts", label: "Tree nuts" },
  { value: "wheat", label: "Wheat" },
  { value: "soy", label: "Soy" },
  { value: "sesame", label: "Sesame" },
];
const ALLERGEN_VALUES = new Set(
  ALLERGEN_OPTIONS.map(({ value }) => value),
);
const normalizeAllergenValue = (value) =>
  value === "gluten" ? "wheat" : value;
const normalizeKnownAllergens = (allergens) => {
  if (!Array.isArray(allergens)) {
    return [];
  }

  const normalizedValues = new Set(
    allergens
      .filter((allergen) => typeof allergen === "string")
      .map(normalizeAllergenValue),
  );

  return ALLERGEN_OPTIONS.map(({ value }) => value).filter((value) =>
    normalizedValues.has(value),
  );
};
const AVAILABILITY_VALUES = new Set(["available", "out"]);
const ORDER_STATUS_LABELS = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected",
  FAILED_TO_PICKUP: "Failed to pick up",
};
const ORDER_STATUS_TRANSITIONS = {
  PENDING: ["CONFIRMED", "CANCELLED", "REJECTED"],
  CONFIRMED: ["CANCELLED"],
  CANCELLED: [],
  REJECTED: [],
  FAILED_TO_PICKUP: [],
};
const normalizeOrderStatus = (value) =>
  typeof value === "string" && value.trim()
    ? value.trim().toUpperCase()
    : "UNKNOWN";
const formatStatusLabel = (value) => {
  const normalized = normalizeOrderStatus(value);
  if (ORDER_STATUS_LABELS[normalized]) {
    return ORDER_STATUS_LABELS[normalized];
  }

  return normalized
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};
const MAX_FULL_DISH_INFO_LENGTH = 4000;
const DISH_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const DISH_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";
const MAX_DISH_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_DISH_IMAGE_ALT_LENGTH = 250;
const MAX_DISH_IMAGE_DIMENSION = 10_000;
const DISH_IMAGE_KEY_PATTERN =
  /^dishes\/([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*)\/([A-Za-z0-9][A-Za-z0-9_-]{0,199})\.(jpg|jpeg|png|webp)$/;

const defaultMenuItems = [
  {
    id: "akami",
    category: "Nigiri",
    name: "Bluefin akami",
    description: "Lean bluefin, aged soy, fresh wasabi, seasoned rice.",
    price: "14",
    allergens: ["fish", "wheat", "soy"],
  },
  {
    id: "miso-salmon",
    category: "Signature",
    name: "Miso ember salmon",
    description: "Torched king salmon, sweet miso, yuzu kosho, crispy leek.",
    price: "18",
    allergens: ["fish", "soy"],
  },
  {
    id: "hamachi",
    category: "Sashimi",
    name: "Hamachi & citrus",
    description: "Yellowtail, blood orange, white ponzu, shiso oil.",
    price: "22",
    allergens: ["fish", "wheat", "soy"],
  },
  {
    id: "kinoko",
    category: "Warm",
    name: "Forest kinoko",
    description: "Robata mushrooms, smoked tofu, tamari butter, sansho.",
    price: "16",
    allergens: ["milk", "soy"],
  },
  {
    id: "sora-roll",
    category: "Maki",
    name: "Snowfox house roll",
    description: "Snow crab, avocado, cucumber, tuna, toasted sesame.",
    price: "24",
    allergens: ["fish", "shellfish", "sesame"],
  },
  {
    id: "matcha",
    category: "Sweet",
    name: "Matcha cloud",
    description: "Ceremonial matcha, white chocolate, black sesame, mochi.",
    price: "13",
    allergens: ["milk", "sesame"],
  },
];

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneNumberPattern = /^\+[1-9]\d{7,14}$/;
const MAX_CUSTOMER_NAME_LENGTH = 100;
const MAX_ORDER_QUANTITY = 20;
const MAX_CUSTOMER_NOTE_LENGTH = 500;
const MAX_RESTAURANT_NOTE_LENGTH = 500;
const PICKUP_FAILURE_HISTORY_PAGE_SIZE = 10;

const normalizePhoneNumber = (value) =>
  value.trim().replace(/[\s().-]/g, "");

const fromEnvOrFallback = (value, fallback) => {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const apiBaseUrl = fromEnvOrFallback(
  import.meta.env.VITE_API_BASE_URL,
  "",
).replace(/\/+$/, "");
const chatSessionsApiUrl = apiBaseUrl ? `${apiBaseUrl}/chat/sessions` : "";
const dishesApiUrl = apiBaseUrl ? `${apiBaseUrl}/dishes` : "";
const privateDishesApiUrl = apiBaseUrl
  ? `${apiBaseUrl}/dishes/private`
  : "";
const dishImageUploadApiUrl = apiBaseUrl
  ? `${apiBaseUrl}/dish-images/upload-url`
  : "";
const dishImagesBaseUrl = fromEnvOrFallback(
  import.meta.env.VITE_DISH_IMAGES_BASE_URL,
  "",
).replace(/\/+$/, "");
const ordersApiUrl = apiBaseUrl ? `${apiBaseUrl}/orders` : "";
const adminOrdersApiUrl = apiBaseUrl ? `${apiBaseUrl}/admin/orders` : "";
const orderingStatusApiUrl = apiBaseUrl
  ? `${apiBaseUrl}/ordering-status`
  : "";
const adminOrderingStatusApiUrl = apiBaseUrl
  ? `${apiBaseUrl}/admin/ordering-status`
  : "";
const announcementsApiUrl = apiBaseUrl
  ? `${apiBaseUrl}/announcements`
  : "";
const privateAnnouncementsApiUrl = apiBaseUrl
  ? `${apiBaseUrl}/announcements/private`
  : "";

const ANNOUNCEMENT_TYPES = [
  { value: "GENERAL", label: "General" },
  { value: "DISCOUNT", label: "Discount" },
  { value: "CLOSURE", label: "Closure" },
  { value: "EVENT", label: "Event" },
];
const ANNOUNCEMENT_TYPE_VALUES = new Set(
  ANNOUNCEMENT_TYPES.map(({ value }) => value),
);
const ANNOUNCEMENT_TYPE_LABELS = Object.fromEntries(
  ANNOUNCEMENT_TYPES.map(({ value, label }) => [value, label]),
);
const ANNOUNCEMENT_STATUSES = [
  { value: "DRAFT", label: "Draft" },
  { value: "PUBLISHED", label: "Published" },
];
const ANNOUNCEMENT_STATUS_VALUES = new Set(
  ANNOUNCEMENT_STATUSES.map(({ value }) => value),
);
const MAX_ANNOUNCEMENT_TITLE_LENGTH = 100;
const MAX_ANNOUNCEMENT_MESSAGE_LENGTH = 1000;
const MAX_ANNOUNCEMENT_PROMO_CODE_LENGTH = 32;
const ANNOUNCEMENT_PROMO_CODE_PATTERN = /^[A-Z0-9_-]+$/;
const MIN_ANNOUNCEMENT_PRIORITY = 0;
const MAX_ANNOUNCEMENT_PRIORITY = 100;

const poolData = {
  UserPoolId: fromEnvOrFallback(
    import.meta.env.VITE_COGNITO_USER_POOL_ID,
    "us-east-1_KI1Z4Cwpe",
  ),
  ClientId: fromEnvOrFallback(
    import.meta.env.VITE_COGNITO_CLIENT_ID,
    "7dro089ssnglnuocqt5q35nphb",
  ),
};

const requiredAdminGroup = fromEnvOrFallback(
  import.meta.env.VITE_COGNITO_ADMIN_GROUP,
  "",
);

const cloneMenuItems = (items) =>
  items.map((item) => ({
    ...item,
    allergens: normalizeKnownAllergens(item.allergens),
    fullDishInfo: item.fullDishInfo || "",
    image: item.image ? { ...item.image } : null,
    availability: item.availability === "out" ? "out" : "available",
  }));

const cloneDefaultMenu = () => cloneMenuItems(defaultMenuItems);

const toPublicMenuItems = (items) =>
  items.map((item) => ({
    id: item.id,
    category: item.category,
    name: item.name,
    description: item.description,
    price: item.price,
    allergens: [...item.allergens],
    image: item.image ? { ...item.image } : null,
    availability: item.availability,
  }));

const normalizeDishImage = (value, dishId) => {
  if (value === undefined || value === null) {
    return null;
  }

  const key = typeof value?.key === "string" ? value.key.trim() : "";
  const keyMatch = DISH_IMAGE_KEY_PATTERN.exec(key);
  const alt = typeof value?.alt === "string" ? value.alt.trim() : null;
  const fields =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value)
      : [];
  const hasOnlyKnownFields = fields.every((field) =>
    ["key", "alt", "width", "height"].includes(field),
  );

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasOnlyKnownFields ||
    !keyMatch ||
    keyMatch[1] !== dishId ||
    alt === null ||
    alt.length > MAX_DISH_IMAGE_ALT_LENGTH ||
    !Number.isInteger(value.width) ||
    value.width <= 0 ||
    value.width > MAX_DISH_IMAGE_DIMENSION ||
    !Number.isInteger(value.height) ||
    value.height <= 0 ||
    value.height > MAX_DISH_IMAGE_DIMENSION
  ) {
    throw new Error("The menu API returned invalid dish image metadata.");
  }

  return {
    key,
    alt,
    width: value.width,
    height: value.height,
  };
};

const getDishImageUrl = (image) => {
  if (!dishImagesBaseUrl || !image?.key) {
    return "";
  }

  const encodedKey = image.key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${dishImagesBaseUrl}/${encodedKey}`;
};

const readDishImageDimensions = (objectUrl) =>
  new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;

      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width > MAX_DISH_IMAGE_DIMENSION ||
        height > MAX_DISH_IMAGE_DIMENSION
      ) {
        reject(
          new Error(
            `Dish images must be no larger than ${MAX_DISH_IMAGE_DIMENSION.toLocaleString()} pixels on either side.`,
          ),
        );
        return;
      }

      resolve({ width, height });
    };
    image.onerror = () =>
      reject(new Error("The selected file could not be read as an image."));
    image.src = objectUrl;
  });

const createUniqueId = (prefix) => {
  const value = globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return `${prefix}-${value}`;
};

const createChatRequestId = () =>
  globalThis.crypto?.randomUUID?.() || createUniqueId("chat-request");

const normalizeChatMessage = (value) => {
  if (
    !value ||
    typeof value.messageId !== "string" ||
    !value.messageId.trim() ||
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.content !== "string" ||
    !value.content.trim() ||
    typeof value.createdAt !== "string" ||
    !value.createdAt.trim()
  ) {
    throw new Error("The chat API returned an invalid message.");
  }

  return {
    id: value.messageId,
    role: value.role,
    content: value.content,
    createdAt: value.createdAt,
  };
};

const normalizeChatSession = (value) => {
  if (
    !value ||
    typeof value.chatId !== "string" ||
    !value.chatId.trim() ||
    typeof value.createdAt !== "string" ||
    !value.createdAt.trim() ||
    (value.messages !== undefined && !Array.isArray(value.messages))
  ) {
    throw new Error("The chat API returned an invalid session.");
  }

  return {
    id: value.chatId,
    createdAt: value.createdAt,
    messages: (value.messages || []).map(normalizeChatMessage),
  };
};

const getChatApiError = (
  payload,
  fallback = "The chat request could not be completed.",
) => payload?.error?.message || payload?.message || fallback;

const normalizeMenuItems = (value) => {
  if (!Array.isArray(value)) {
    throw new Error("The menu API returned an invalid response.");
  }

  return value.map((item) => {
    const allergens = item?.allergens ?? [];
    const normalizedAllergens = Array.isArray(allergens)
      ? allergens.map(normalizeAllergenValue)
      : [];
    const fullDishInfo = item?.fullDishInfo ?? "";
    const availability = item?.availability ?? "available";
    const hasInvalidAllergens =
      !Array.isArray(allergens) ||
      allergens.some(
        (allergen) =>
          typeof allergen !== "string" ||
          !ALLERGEN_VALUES.has(normalizeAllergenValue(allergen)),
      );

    if (
      !item ||
      typeof item.id !== "string" ||
      typeof item.category !== "string" ||
      typeof item.name !== "string" ||
      typeof item.description !== "string" ||
      typeof item.price !== "string" ||
      !item.id.trim() ||
      !item.category.trim() ||
      !item.name.trim() ||
      !item.description.trim() ||
      !Number.isFinite(Number(item.price)) ||
      hasInvalidAllergens ||
      !AVAILABILITY_VALUES.has(availability) ||
      typeof fullDishInfo !== "string" ||
      fullDishInfo.length > MAX_FULL_DISH_INFO_LENGTH
    ) {
      throw new Error("The menu API returned an invalid dish.");
    }

    return {
      id: item.id,
      category: item.category,
      name: item.name,
      description: item.description,
      price: item.price,
      allergens: ALLERGEN_OPTIONS.map(({ value }) => value).filter(
        (allergen) => normalizedAllergens.includes(allergen),
      ),
      fullDishInfo,
      image: normalizeDishImage(item.image, item.id),
      availability,
    };
  });
};

const createUserPool = () => new CognitoUserPool(poolData);

const extractSessionInfo = (session) => {
  const idToken = session.getIdToken();
  const payload = idToken?.payload || {};
  const rawGroups = payload["cognito:groups"];

  return {
    idToken: idToken.getJwtToken(),
    accessToken: session.getAccessToken().getJwtToken(),
    refreshToken: session.getRefreshToken().getToken(),
    groups: Array.isArray(rawGroups) ? rawGroups : [],
    email: typeof payload.email === "string" ? payload.email : "",
    name: typeof payload.name === "string" ? payload.name : "",
    phoneNumber:
      typeof payload.phone_number === "string" ? payload.phone_number : "",
    userId: typeof payload.sub === "string" ? payload.sub : "",
  };
};

const getCurrentSessionInfo = () =>
  new Promise((resolve, reject) => {
    let currentUser;

    try {
      currentUser = createUserPool().getCurrentUser();
    } catch (error) {
      reject(error);
      return;
    }

    if (!currentUser) {
      reject(new Error("Your session has ended. Please sign in again."));
      return;
    }

    currentUser.getSession((error, session) => {
      if (error || !session?.isValid()) {
        reject(new Error("Your session has ended. Please sign in again."));
        return;
      }

      resolve(extractSessionInfo(session));
    });
  });

const hasAdminAccess = (sessionInfo) =>
  Boolean(
    sessionInfo &&
      (!requiredAdminGroup || sessionInfo.groups.includes(requiredAdminGroup)),
  );

const clearLegacySessionCache = () => {
  try {
    sessionStorage.removeItem("cognito_session_tokens");
  } catch {
    // The Cognito SDK maintains the authoritative session cache.
  }
};

const validateSignIn = (values) => {
  const errors = {};

  if (!values.email.trim()) {
    errors.email = "Email is required.";
  } else if (!emailPattern.test(values.email)) {
    errors.email = "Enter a valid email address.";
  }

  if (!values.password) {
    errors.password = "Password is required.";
  }

  return errors;
};

const validateSignUp = (values) => {
  const errors = {};

  if (!values.fullName.trim()) {
    errors.fullName = "Full name is required.";
  } else if (values.fullName.trim().length > MAX_CUSTOMER_NAME_LENGTH) {
    errors.fullName = `Full name must not exceed ${MAX_CUSTOMER_NAME_LENGTH} characters.`;
  }

  const phoneNumber = normalizePhoneNumber(values.phoneNumber);
  if (!phoneNumber) {
    errors.phoneNumber = "Phone number is required.";
  } else if (!phoneNumberPattern.test(phoneNumber)) {
    errors.phoneNumber =
      "Enter a phone number with country code, such as +1 415 555 2671.";
  }

  if (!values.email.trim()) {
    errors.email = "Email is required.";
  } else if (!emailPattern.test(values.email)) {
    errors.email = "Enter a valid email address.";
  }

  if (!values.password) {
    errors.password = "Password is required.";
  } else if (
    values.password.length < 8 ||
    !/[a-z]/.test(values.password) ||
    !/[A-Z]/.test(values.password) ||
    !/\d/.test(values.password)
  ) {
    errors.password =
      "Use 8 or more characters with uppercase, lowercase, and a number.";
  }

  if (!values.confirmPassword) {
    errors.confirmPassword = "Confirm your password.";
  } else if (values.confirmPassword !== values.password) {
    errors.confirmPassword = "The passwords do not match.";
  }

  return errors;
};

const validateConfirmation = (values) => {
  const errors = {};

  if (!values.email.trim()) {
    errors.email = "Email is required.";
  } else if (!emailPattern.test(values.email)) {
    errors.email = "Enter a valid email address.";
  }

  if (!values.code.trim()) {
    errors.code = "Confirmation code is required.";
  } else if (!/^\d{6}$/.test(values.code.trim())) {
    errors.code = "Enter the 6-digit code from your email.";
  }

  return errors;
};

const validatePasswordResetRequest = (values) => {
  const errors = {};

  if (!values.email.trim()) {
    errors.email = "Email is required.";
  } else if (!emailPattern.test(values.email)) {
    errors.email = "Enter a valid email address.";
  }

  return errors;
};

const validatePasswordReset = (values) => {
  const errors = validatePasswordResetRequest(values);

  if (!values.code.trim()) {
    errors.code = "Reset code is required.";
  } else if (!/^\d{6}$/.test(values.code.trim())) {
    errors.code = "Enter the 6-digit code from your email.";
  }

  if (!values.password) {
    errors.password = "New password is required.";
  } else if (
    values.password.length < 8 ||
    !/[a-z]/.test(values.password) ||
    !/[A-Z]/.test(values.password) ||
    !/\d/.test(values.password)
  ) {
    errors.password =
      "Use 8 or more characters with uppercase, lowercase, and a number.";
  }

  if (!values.confirmPassword) {
    errors.confirmPassword = "Confirm your new password.";
  } else if (values.confirmPassword !== values.password) {
    errors.confirmPassword = "The passwords do not match.";
  }

  return errors;
};

const validatePickup = (values) => {
  const errors = {};
  const name = values.name.trim();
  const phoneNumber = normalizePhoneNumber(values.phoneNumber);

  if (!name) {
    errors.name = "Pickup name is required.";
  } else if (name.length > MAX_CUSTOMER_NAME_LENGTH) {
    errors.name = `Pickup name must not exceed ${MAX_CUSTOMER_NAME_LENGTH} characters.`;
  }

  if (!phoneNumber) {
    errors.phoneNumber = "Phone number is required.";
  } else if (!phoneNumberPattern.test(phoneNumber)) {
    errors.phoneNumber =
      "Enter a phone number with country code, such as +1 415 555 2671.";
  }

  if (values.note.length > MAX_CUSTOMER_NOTE_LENGTH) {
    errors.note = `The note must not exceed ${MAX_CUSTOMER_NOTE_LENGTH} characters.`;
  }

  return errors;
};

const signUpUser = (values) => {
  const email = values.email.trim().toLowerCase();
  const userPool = createUserPool();
  const attributes = [
    new CognitoUserAttribute({ Name: "email", Value: email }),
    new CognitoUserAttribute({
      Name: "name",
      Value: values.fullName.trim(),
    }),
    new CognitoUserAttribute({
      Name: "phone_number",
      Value: normalizePhoneNumber(values.phoneNumber),
    }),
  ];

  return new Promise((resolve, reject) => {
    userPool.signUp(
      email,
      values.password,
      attributes,
      null,
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      },
    );
  });
};

const createCognitoUser = (email) =>
  new CognitoUser({
    Username: email.trim().toLowerCase(),
    Pool: createUserPool(),
  });

const confirmUserRegistration = (email, code) =>
  new Promise((resolve, reject) => {
    createCognitoUser(email).confirmRegistration(
      code.trim(),
      false,
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      },
    );
  });

const resendUserConfirmationCode = (email) =>
  new Promise((resolve, reject) => {
    createCognitoUser(email).resendConfirmationCode((error, result) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    });
  });

const requestUserPasswordReset = (email) =>
  new Promise((resolve, reject) => {
    createCognitoUser(email).forgotPassword({
      onSuccess: resolve,
      inputVerificationCode: resolve,
      onFailure: reject,
    });
  });

const confirmUserPasswordReset = (email, code, password) =>
  new Promise((resolve, reject) => {
    createCognitoUser(email).confirmPassword(code.trim(), password, {
      onSuccess: resolve,
      onFailure: reject,
    });
  });

const signInUser = (values) => {
  const email = values.email.trim().toLowerCase();
  const userPool = createUserPool();
  const user = new CognitoUser({ Username: email, Pool: userPool });
  const authenticationDetails = new AuthenticationDetails({
    Username: email,
    Password: values.password,
  });

  return new Promise((resolve, reject) => {
    user.authenticateUser(authenticationDetails, {
      onSuccess: (session) => resolve({ session, user }),
      onFailure: reject,
      newPasswordRequired: () =>
        reject(new Error("A new password is required for this account.")),
      mfaRequired: () =>
        reject(
          new Error(
            "MFA is required for this account. MFA handling is not configured yet.",
          ),
        ),
      totpRequired: () =>
        reject(
          new Error(
            "Authenticator verification is required. TOTP handling is not configured yet.",
          ),
        ),
    });
  });
};

const getSignInErrorMessage = (error) => {
  if (error?.code === "NotAuthorizedException") {
    return "The email or password is incorrect.";
  }

  if (error?.code === "UserNotConfirmedException") {
    return "This account still needs to be confirmed.";
  }

  return error?.message || "Sign in failed. Please try again.";
};

const getSignUpErrorMessage = (error) => {
  if (error?.code === "UsernameExistsException") {
    return "An account may already exist for this email. Sign in, or confirm the account if it has not been verified.";
  }

  if (error?.code === "InvalidPasswordException") {
    return "Use 8 or more characters with uppercase, lowercase, and a number.";
  }

  if (
    error?.code === "LimitExceededException" ||
    error?.code === "TooManyRequestsException"
  ) {
    return "Too many registration attempts. Please wait and try again.";
  }

  if (error?.code === "NotAuthorizedException") {
    return "Self-service registration is currently unavailable.";
  }

  return error?.message || "Account creation failed. Please try again.";
};

const getConfirmationErrorMessage = (error) => {
  if (error?.code === "CodeMismatchException") {
    return "That confirmation code is incorrect.";
  }

  if (error?.code === "ExpiredCodeException") {
    return "That confirmation code has expired. Request a new code.";
  }

  if (
    error?.code === "LimitExceededException" ||
    error?.code === "TooManyRequestsException" ||
    error?.code === "TooManyFailedAttemptsException"
  ) {
    return "Too many attempts. Please wait and try again.";
  }

  if (error?.code === "NotAuthorizedException") {
    return "This account may already be confirmed. Try signing in.";
  }

  if (error?.code === "UserNotFoundException") {
    return "The confirmation request could not be completed. Check the email address.";
  }

  return error?.message || "Email confirmation failed. Please try again.";
};

const getPasswordResetErrorMessage = (error) => {
  if (
    error?.code === "CodeMismatchException" ||
    error?.code === "ExpiredCodeException" ||
    error?.code === "UserNotFoundException" ||
    error?.code === "InvalidParameterException" ||
    error?.code === "NotAuthorizedException"
  ) {
    return "That reset code is incorrect or expired. Request a new code and try again.";
  }

  if (error?.code === "InvalidPasswordException") {
    return "Use 8 or more characters with uppercase, lowercase, and a number.";
  }

  if (
    error?.code === "LimitExceededException" ||
    error?.code === "TooManyRequestsException" ||
    error?.code === "TooManyFailedAttemptsException"
  ) {
    return "Too many password reset attempts. Please wait and try again.";
  }

  if (error?.code === "CodeDeliveryFailureException") {
    return "The reset email could not be delivered. Please wait and try again.";
  }

  return "Password reset failed. Please try again.";
};

const priceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const orderDateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});
const pickupTimeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

const getPriceCents = (price) => Math.round(Number(price) * 100);
const formatPriceCents = (cents) => priceFormatter.format(cents / 100);
const formatOrderDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown time"
    : orderDateFormatter.format(date);
};
const formatPickupTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown pickup time"
    : pickupTimeFormatter.format(date);
};
const isCanonicalIsoTimestamp = (value) => {
  if (typeof value !== "string" || !value) {
    return false;
  }

  const date = new Date(value);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString() === value
  );
};
const parsePickupFailureHistory = (payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("The pickup history API returned an invalid response.");
  }

  const {
    failedPickupCount,
    lastFailedPickupAt,
    lastFailedOrderId,
    failures,
    nextToken,
  } = payload;

  if (
    !Number.isSafeInteger(failedPickupCount) ||
    failedPickupCount < 0 ||
    !Array.isArray(failures) ||
    !(nextToken === null || typeof nextToken === "string")
  ) {
    throw new Error("The pickup history API returned an invalid response.");
  }

  if (
    (lastFailedPickupAt !== undefined &&
      !isCanonicalIsoTimestamp(lastFailedPickupAt)) ||
    (lastFailedOrderId !== undefined &&
      (typeof lastFailedOrderId !== "string" || !lastFailedOrderId.trim()))
  ) {
    throw new Error("The pickup history API returned an invalid response.");
  }

  const seenOrderIds = new Set();
  const normalizedFailures = failures.map((failure) => {
    if (
      !failure ||
      typeof failure !== "object" ||
      Array.isArray(failure) ||
      typeof failure.orderId !== "string" ||
      !failure.orderId.trim() ||
      !isCanonicalIsoTimestamp(failure.scheduledPickupTime) ||
      !isCanonicalIsoTimestamp(failure.failedPickupAt) ||
      seenOrderIds.has(failure.orderId)
    ) {
      throw new Error("The pickup history API returned an invalid response.");
    }

    seenOrderIds.add(failure.orderId);
    return {
      orderId: failure.orderId,
      scheduledPickupTime: failure.scheduledPickupTime,
      failedPickupAt: failure.failedPickupAt,
    };
  });

  if (normalizedFailures.length > failedPickupCount) {
    throw new Error("The pickup history API returned an invalid response.");
  }

  return {
    failedPickupCount,
    lastFailedPickupAt: lastFailedPickupAt || "",
    lastFailedOrderId: lastFailedOrderId || "",
    failures: normalizedFailures,
    nextToken: nextToken || "",
  };
};
const getCurrentTimestamp = () => Date.now();
const toLocalDateTimeInputValue = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const localDate = new Date(
    date.getTime() - date.getTimezoneOffset() * 60 * 1000,
  );
  return localDate.toISOString().slice(0, 16);
};

const toCanonicalAnnouncementTimestamp = (value) => {
  if (typeof value !== "string" || !value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

const createAnnouncementFormValues = (announcement = null) => {
  if (announcement) {
    return {
      type: announcement.type,
      title: announcement.title,
      message: announcement.message,
      promoCode: announcement.promoCode || "",
      status: announcement.status,
      startsAt: toLocalDateTimeInputValue(announcement.startsAt),
      endsAt: toLocalDateTimeInputValue(announcement.endsAt),
      priority: String(announcement.priority),
    };
  }

  const startsAt = new Date();
  startsAt.setSeconds(0, 0);
  const endsAt = new Date(startsAt.getTime() + 7 * 24 * 60 * 60 * 1000);

  return {
    type: "GENERAL",
    title: "",
    message: "",
    promoCode: "",
    status: "DRAFT",
    startsAt: toLocalDateTimeInputValue(startsAt),
    endsAt: toLocalDateTimeInputValue(endsAt),
    priority: "0",
  };
};

const validateAnnouncementForm = (values) => {
  const errors = {};
  const title = values.title.trim();
  const message = values.message.trim();
  const promoCode = values.promoCode.trim().toUpperCase();
  const priority = Number(values.priority);
  const startsAt = toCanonicalAnnouncementTimestamp(values.startsAt);
  const endsAt = toCanonicalAnnouncementTimestamp(values.endsAt);

  if (!ANNOUNCEMENT_TYPE_VALUES.has(values.type)) {
    errors.type = "Choose a valid announcement type.";
  }

  if (!title) {
    errors.title = "Title is required.";
  } else if (title.length > MAX_ANNOUNCEMENT_TITLE_LENGTH) {
    errors.title = `Title must not exceed ${MAX_ANNOUNCEMENT_TITLE_LENGTH} characters.`;
  }

  if (!message) {
    errors.message = "Message is required.";
  } else if (message.length > MAX_ANNOUNCEMENT_MESSAGE_LENGTH) {
    errors.message = `Message must not exceed ${MAX_ANNOUNCEMENT_MESSAGE_LENGTH} characters.`;
  }

  if (values.type !== "DISCOUNT" && promoCode) {
    errors.promoCode = "Promo codes can only be added to discount announcements.";
  } else if (promoCode.length > MAX_ANNOUNCEMENT_PROMO_CODE_LENGTH) {
    errors.promoCode = `Promo code must not exceed ${MAX_ANNOUNCEMENT_PROMO_CODE_LENGTH} characters.`;
  } else if (promoCode && !ANNOUNCEMENT_PROMO_CODE_PATTERN.test(promoCode)) {
    errors.promoCode =
      "Use only uppercase letters, numbers, hyphens, and underscores.";
  }

  if (!ANNOUNCEMENT_STATUS_VALUES.has(values.status)) {
    errors.status = "Choose Draft or Published.";
  }

  if (!startsAt) {
    errors.startsAt = "Enter a valid start date and time.";
  }

  if (!endsAt) {
    errors.endsAt = "Enter a valid end date and time.";
  } else if (startsAt && new Date(startsAt) >= new Date(endsAt)) {
    errors.endsAt = "End date and time must be after the start.";
  }

  if (
    !values.priority.trim() ||
    !Number.isInteger(priority) ||
    priority < MIN_ANNOUNCEMENT_PRIORITY ||
    priority > MAX_ANNOUNCEMENT_PRIORITY
  ) {
    errors.priority =
      `Priority must be a whole number from ${MIN_ANNOUNCEMENT_PRIORITY} to ${MAX_ANNOUNCEMENT_PRIORITY}.`;
  }

  return errors;
};

const toAnnouncementRequest = (values) => ({
  type: values.type,
  title: values.title.trim(),
  message: values.message.trim(),
  ...(values.type === "DISCOUNT" && values.promoCode.trim()
    ? { promoCode: values.promoCode.trim().toUpperCase() }
    : {}),
  status: values.status,
  startsAt: toCanonicalAnnouncementTimestamp(values.startsAt),
  endsAt: toCanonicalAnnouncementTimestamp(values.endsAt),
  priority: Number(values.priority),
});

const normalizeAnnouncement = (value, { requireAdminFields = false } = {}) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const announcementId =
    typeof value.announcementId === "string"
      ? value.announcementId.trim()
      : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const message = typeof value.message === "string" ? value.message.trim() : "";
  const promoCode =
    typeof value.promoCode === "string"
      ? value.promoCode.trim().toUpperCase()
      : "";
  const status =
    typeof value.status === "string" ? value.status.trim().toUpperCase() : "";

  if (
    !announcementId ||
    !ANNOUNCEMENT_TYPE_VALUES.has(value.type) ||
    !title ||
    title.length > MAX_ANNOUNCEMENT_TITLE_LENGTH ||
    !message ||
    message.length > MAX_ANNOUNCEMENT_MESSAGE_LENGTH ||
    (promoCode &&
      (value.type !== "DISCOUNT" ||
        promoCode.length > MAX_ANNOUNCEMENT_PROMO_CODE_LENGTH ||
        !ANNOUNCEMENT_PROMO_CODE_PATTERN.test(promoCode))) ||
    (status && !ANNOUNCEMENT_STATUS_VALUES.has(status)) ||
    !isCanonicalIsoTimestamp(value.startsAt) ||
    !isCanonicalIsoTimestamp(value.endsAt) ||
    new Date(value.startsAt) >= new Date(value.endsAt) ||
    !Number.isInteger(value.priority) ||
    value.priority < MIN_ANNOUNCEMENT_PRIORITY ||
    value.priority > MAX_ANNOUNCEMENT_PRIORITY ||
    (requireAdminFields &&
      (!ANNOUNCEMENT_STATUS_VALUES.has(status) ||
        !isCanonicalIsoTimestamp(value.createdAt) ||
        !isCanonicalIsoTimestamp(value.updatedAt)))
  ) {
    return null;
  }

  return {
    announcementId,
    type: value.type,
    title,
    message,
    ...(promoCode ? { promoCode } : {}),
    status: status || "PUBLISHED",
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    priority: value.priority,
    createdAt:
      typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt:
      typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
};

const compareAnnouncements = (left, right) =>
  right.priority - left.priority ||
  new Date(right.startsAt) - new Date(left.startsAt) ||
  left.announcementId.localeCompare(right.announcementId);

const normalizeAnnouncementList = (
  payload,
  { requireAdminFields = false } = {},
) => {
  if (!Array.isArray(payload?.announcements)) {
    throw new Error("The announcements API returned an invalid response.");
  }

  const announcements = payload.announcements.map((announcement) =>
    normalizeAnnouncement(announcement, { requireAdminFields }),
  );

  if (requireAdminFields && announcements.some((announcement) => !announcement)) {
    throw new Error("The announcements API returned invalid announcement data.");
  }

  return announcements.filter(Boolean).sort(compareAnnouncements);
};

const getAnnouncementApiError = (
  payload,
  fallback = "The announcement request could not be completed.",
) => {
  const details = Array.isArray(payload?.error?.details)
    ? payload.error.details
        .map(({ field, message }) =>
          field && message ? `${field}: ${message}` : message,
        )
        .filter(Boolean)
        .join("; ")
    : "";

  return details || payload?.error?.message || payload?.message || fallback;
};

const announcementDateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const formatAnnouncementWindow = (startsAt, endsAt) =>
  `${announcementDateFormatter.format(new Date(startsAt))} – ${announcementDateFormatter.format(
    new Date(endsAt),
  )}`;

const requestAnnouncementList = async ({
  url,
  idToken = "",
  requireAdminFields = false,
  signal,
}) => {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(idToken ? { Authorization: idToken } : {}),
    },
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The announcements API returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(
      getAnnouncementApiError(
        payload,
        requireAdminFields
          ? "Announcements could not be loaded."
          : "Restaurant updates are temporarily unavailable.",
      ),
    );
  }

  return normalizeAnnouncementList(payload, { requireAdminFields });
};

const requestOrderingStatus = async ({
  url,
  idToken = "",
  method = "GET",
  statusUpdate,
  signal,
}) => {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(idToken ? { Authorization: idToken } : {}),
      ...(statusUpdate ? { "Content-Type": "application/json" } : {}),
    },
    cache: "no-store",
    ...(statusUpdate ? { body: JSON.stringify(statusUpdate) } : {}),
    ...(signal ? { signal } : {}),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The ordering status API returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.message ||
        "The ordering status could not be updated.",
    );
  }

  return normalizeOrderingStatus(payload);
};

function Modal({ isOpen, onClose, titleId, className = "", children }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return undefined;
    }

    if (!isOpen) {
      if (dialog.open) {
        dialog.close();
      }
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!dialog.open) {
      dialog.showModal();
    }

    const focusFrame = requestAnimationFrame(() => {
      dialog.querySelector("[data-autofocus]")?.focus();
    });

    return () => {
      cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [isOpen]);

  return (
    <dialog
      ref={dialogRef}
      className={`modal ${className}`.trim()}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      {children}
    </dialog>
  );
}

function MobileNavIcon({ name }) {
  const paths = {
    home: (
      <>
        <path d="m3 10.5 9-7.5 9 7.5" />
        <path d="M5 9.5V21h14V9.5M9 21v-6h6v6" />
      </>
    ),
    menu: (
      <>
        <path d="M5 6h14M5 12h14M5 18h14" />
        <path d="M3 6h.01M3 12h.01M3 18h.01" />
      </>
    ),
    visit: (
      <>
        <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
        <circle cx="12" cy="10" r="2.5" />
      </>
    ),
    chat: (
      <>
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9.7 9.7 0 0 1-4-.9L3 21l1.7-4.5A8.2 8.2 0 0 1 3 11.5a8.4 8.4 0 0 1 9-8.5 8.4 8.4 0 0 1 9 8.5Z" />
        <path d="M8 11.5h.01M12 11.5h.01M16 11.5h.01" />
      </>
    ),
    cart: (
      <>
        <path d="M3 5h2l2.2 10.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L20.5 8H6" />
        <circle cx="9.5" cy="20" r="1" />
        <circle cx="17" cy="20" r="1" />
      </>
    ),
    orders: (
      <>
        <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
        <path d="M9 8h6M9 12h6M9 16h3" />
      </>
    ),
    account: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
      </>
    ),
    admin: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
      </>
    ),
    edit: (
      <>
        <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
        <path d="m13.5 6.5 4 4" />
      </>
    ),
    announcements: (
      <>
        <path d="M4 11v2a2 2 0 0 0 2 2h2l7 4V5L8 9H6a2 2 0 0 0-2 2Z" />
        <path d="M8 15v4M18 8.5a5 5 0 0 1 0 7" />
      </>
    ),
    signout: (
      <>
        <path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5" />
        <path d="M14 8l4 4-4 4M8 12h10" />
      </>
    ),
  };

  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

function App() {
  const [authStatus, setAuthStatus] = useState("restoring");
  const [sessionInfo, setSessionInfo] = useState(null);
  const [currentUserEmail, setCurrentUserEmail] = useState("");
  const [authView, setAuthView] = useState("signIn");
  const [signInValues, setSignInValues] = useState(initialSignInValues);
  const [signInErrors, setSignInErrors] = useState({});
  const [signUpValues, setSignUpValues] = useState(initialSignUpValues);
  const [signUpErrors, setSignUpErrors] = useState({});
  const [confirmationValues, setConfirmationValues] = useState(
    initialConfirmationValues,
  );
  const [confirmationErrors, setConfirmationErrors] = useState({});
  const [passwordResetValues, setPasswordResetValues] = useState(
    initialPasswordResetValues,
  );
  const [passwordResetErrors, setPasswordResetErrors] = useState({});
  const [signInError, setSignInError] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isResendingCode, setIsResendingCode] = useState(false);
  const [isRequestingPasswordReset, setIsRequestingPasswordReset] =
    useState(false);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [signInPurpose, setSignInPurpose] = useState("chat");
  const [isSignInModalOpen, setIsSignInModalOpen] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const authPanelRef = useRef(null);

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [activeChat, setActiveChat] = useState(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatError, setChatError] = useState("");
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const [isSendingChatMessage, setIsSendingChatMessage] = useState(false);
  const chatLogRef = useRef(null);
  const chatSessionGenerationRef = useRef(0);
  const chatSessionCreationInFlightRef = useRef(false);
  const chatSubmissionInFlightRef = useRef(false);
  const pendingChatRequestRef = useRef(null);

  const [cartQuantities, setCartQuantities] = useState({});
  const [isOrderOpen, setIsOrderOpen] = useState(false);
  const [orderView, setOrderView] = useState("cart");
  const [pickupValues, setPickupValues] = useState(initialPickupValues);
  const [pickupErrors, setPickupErrors] = useState({});
  const [orderError, setOrderError] = useState("");
  const [orderConfirmation, setOrderConfirmation] = useState(null);
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);
  const [orderClientRequestId, setOrderClientRequestId] = useState(() =>
    createUniqueId("order"),
  );
  const orderSubmissionInFlightRef = useRef(false);
  const [orderingStatus, setOrderingStatus] = useState({
    acceptingOrders: true,
    message: "",
    updatedAt: "",
    updatedBy: "",
  });
  const [orderingStatusRequestState, setOrderingStatusRequestState] = useState(
    orderingStatusApiUrl ? "unknown" : "ready",
  );
  const orderingStatusRequestSequenceRef = useRef(0);
  const orderingStatusRequestControllerRef = useRef(null);

  const [isAdminWorkspaceOpen, setIsAdminWorkspaceOpen] = useState(false);
  const [isAdminOrdersOpen, setIsAdminOrdersOpen] = useState(false);
  const [adminOrders, setAdminOrders] = useState([]);
  const [adminOrdersNextToken, setAdminOrdersNextToken] = useState("");
  const [adminOrdersError, setAdminOrdersError] = useState("");
  const [isLoadingAdminOrders, setIsLoadingAdminOrders] = useState(false);
  const [adminOrderStatusSelections, setAdminOrderStatusSelections] = useState(
    {},
  );
  const [adminOrderStatusDetails, setAdminOrderStatusDetails] = useState({});
  const [adminOrderStatusErrors, setAdminOrderStatusErrors] = useState({});
  const [adminOrderStatusUpdating, setAdminOrderStatusUpdating] = useState({});
  const [adminOrderStatusNotice, setAdminOrderStatusNotice] = useState(null);
  const [adminOrderingPauseMessage, setAdminOrderingPauseMessage] =
    useState("");
  const [isUpdatingAdminOrderingStatus, setIsUpdatingAdminOrderingStatus] =
    useState(false);
  const [adminOrderingStatusAction, setAdminOrderingStatusAction] =
    useState("");
  const [adminOrderClock, setAdminOrderClock] = useState(getCurrentTimestamp);
  const [pickupFailureDialog, setPickupFailureDialog] = useState(null);
  const [adminPickupFailureHistories, setAdminPickupFailureHistories] =
    useState({});
  const adminOrdersLoadSequence = useRef(0);
  const adminOrderStatusUpdateGeneration = useRef(0);
  const adminOrderStatusRequests = useRef(new Map());
  const adminPickupFailureHistoryGeneration = useRef(0);
  const adminPickupFailureHistoryRequests = useRef(new Map());
  const adminOrderStatusNoticeRef = useRef(null);
  const shouldFocusAdminOrderStatusNotice = useRef(false);

  const [isCustomerOrdersOpen, setIsCustomerOrdersOpen] = useState(false);
  const [customerOrders, setCustomerOrders] = useState([]);
  const [customerOrdersNextToken, setCustomerOrdersNextToken] = useState("");
  const [customerOrdersError, setCustomerOrdersError] = useState("");
  const [isLoadingCustomerOrders, setIsLoadingCustomerOrders] = useState(false);
  const customerOrdersLoadSequence = useRef(0);

  const [publicAnnouncements, setPublicAnnouncements] = useState([]);
  const [isAnnouncementsOpen, setIsAnnouncementsOpen] = useState(false);
  const [adminAnnouncements, setAdminAnnouncements] = useState([]);
  const [isLoadingAnnouncements, setIsLoadingAnnouncements] = useState(false);
  const [announcementError, setAnnouncementError] = useState("");
  const [announcementNotice, setAnnouncementNotice] = useState("");
  const [announcementForm, setAnnouncementForm] = useState(
    createAnnouncementFormValues,
  );
  const [announcementFormErrors, setAnnouncementFormErrors] = useState({});
  const [editingAnnouncementId, setEditingAnnouncementId] = useState("");
  const [announcementMutation, setAnnouncementMutation] = useState("");
  const announcementsLoadSequence = useRef(0);

  const [menuItems, setMenuItems] = useState(cloneDefaultMenu);
  const [draftMenuItems, setDraftMenuItems] = useState([]);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isLoadingEditor, setIsLoadingEditor] = useState(false);
  const [editorError, setEditorError] = useState("");
  const editorLoadSequence = useRef(0);
  const [menuNotice, setMenuNotice] = useState(() =>
    dishesApiUrl
      ? ""
      : "Showing the sample menu because the menu API is not configured.",
  );
  const [isMenuLoading, setIsMenuLoading] = useState(Boolean(dishesApiUrl));
  const [menuDataStatus, setMenuDataStatus] = useState(
    dishesApiUrl ? "loading" : "sample",
  );
  const [isSavingMenu, setIsSavingMenu] = useState(false);
  const [pendingDishImages, setPendingDishImages] = useState({});
  const pendingDishImagesRef = useRef({});

  const refreshOrderingStatus = useCallback(async () => {
    if (!orderingStatusApiUrl) {
      setOrderingStatusRequestState("ready");
      return null;
    }

    const requestSequence = orderingStatusRequestSequenceRef.current + 1;
    orderingStatusRequestSequenceRef.current = requestSequence;
    orderingStatusRequestControllerRef.current?.abort();

    const controller = new AbortController();
    orderingStatusRequestControllerRef.current = controller;
    setOrderingStatusRequestState("loading");

    try {
      const status = await requestOrderingStatus({
        url: orderingStatusApiUrl,
        signal: controller.signal,
      });

      if (orderingStatusRequestSequenceRef.current === requestSequence) {
        setOrderingStatus(status);
        setOrderingStatusRequestState("ready");
      }

      return status;
    } catch (error) {
      if (
        error?.name !== "AbortError" &&
        orderingStatusRequestSequenceRef.current === requestSequence
      ) {
        setOrderingStatusRequestState("error");
      }
      throw error;
    } finally {
      if (orderingStatusRequestSequenceRef.current === requestSequence) {
        orderingStatusRequestControllerRef.current = null;
      }
    }
  }, []);

  const replacePendingDishImage = (dishId, pendingImage) => {
    const previousImage = pendingDishImagesRef.current[dishId];
    if (
      previousImage?.previewUrl &&
      previousImage.previewUrl !== pendingImage.previewUrl
    ) {
      URL.revokeObjectURL(previousImage.previewUrl);
    }

    const nextImages = {
      ...pendingDishImagesRef.current,
      [dishId]: pendingImage,
    };
    pendingDishImagesRef.current = nextImages;
    setPendingDishImages(nextImages);
  };

  const discardPendingDishImage = (dishId) => {
    const previousImage = pendingDishImagesRef.current[dishId];
    if (previousImage?.previewUrl) {
      URL.revokeObjectURL(previousImage.previewUrl);
    }

    const nextImages = { ...pendingDishImagesRef.current };
    delete nextImages[dishId];
    pendingDishImagesRef.current = nextImages;
    setPendingDishImages(nextImages);
  };

  const clearPendingDishImages = () => {
    Object.values(pendingDishImagesRef.current).forEach((pendingImage) => {
      if (pendingImage?.previewUrl) {
        URL.revokeObjectURL(pendingImage.previewUrl);
      }
    });
    pendingDishImagesRef.current = {};
    setPendingDishImages({});
  };

  useEffect(
    () => () => {
      Object.values(pendingDishImagesRef.current).forEach((pendingImage) => {
        if (pendingImage?.previewUrl) {
          URL.revokeObjectURL(pendingImage.previewUrl);
        }
      });
      pendingDishImagesRef.current = {};
    },
    [],
  );

  useEffect(() => {
    if (!dishesApiUrl) {
      return undefined;
    }

    const controller = new AbortController();

    const loadMenu = async () => {
      try {
        const response = await fetch(dishesApiUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });

        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new Error("The menu API returned an invalid response.");
        }

        if (!response.ok) {
          throw new Error(
            payload?.error?.message || "The live menu could not be loaded.",
          );
        }

        const loadedItems = normalizeMenuItems(payload);
        if (loadedItems.length === 0) {
          setMenuItems(cloneDefaultMenu());
          setMenuDataStatus("sample");
          setMenuNotice(
            "Showing the sample menu until an admin publishes it.",
          );
        } else {
          setMenuItems(toPublicMenuItems(loadedItems));
          setMenuDataStatus("live");
          setMenuNotice("");
        }
      } catch (error) {
        if (error?.name !== "AbortError") {
          setMenuItems(cloneDefaultMenu());
          setMenuDataStatus("error");
          setMenuNotice("The live menu is unavailable. Showing the sample menu.");
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsMenuLoading(false);
        }
      }
    };

    loadMenu();

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!orderingStatusApiUrl) {
      return undefined;
    }

    refreshOrderingStatus().catch(() => {
      // The error state keeps live ordering unavailable until a retry succeeds.
    });

    return () => {
      orderingStatusRequestSequenceRef.current += 1;
      orderingStatusRequestControllerRef.current?.abort();
      orderingStatusRequestControllerRef.current = null;
    };
  }, [refreshOrderingStatus]);

  useEffect(() => {
    if (!orderingStatusApiUrl) {
      return undefined;
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        refreshOrderingStatus().catch(() => {
          // The shared request state exposes the failure and retry action.
        });
      }
    };

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshOrderingStatus]);

  useEffect(() => {
    if (!orderingStatus.acceptingOrders) {
      setAdminOrderingPauseMessage(orderingStatus.message);
    }
  }, [orderingStatus.acceptingOrders, orderingStatus.message]);

  useEffect(() => {
    if (!announcementsApiUrl) {
      return undefined;
    }

    const controller = new AbortController();

    requestAnnouncementList({
      url: announcementsApiUrl,
      signal: controller.signal,
    })
      .then((announcements) => {
        if (!controller.signal.aborted) {
          setPublicAnnouncements(announcements);
        }
      })
      .catch(() => {
        // Announcements are supplementary and must never block the menu.
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    let isMounted = true;
    clearLegacySessionCache();

    const restoreSession = async () => {
      await Promise.resolve();
      if (!isMounted) {
        return;
      }

      let userPool;
      try {
        userPool = createUserPool();
      } catch {
        setAuthStatus("anonymous");
        return;
      }

      const currentUser = userPool.getCurrentUser();
      if (!currentUser) {
        setAuthStatus("anonymous");
        return;
      }

      currentUser.getSession((error, session) => {
        if (!isMounted) {
          return;
        }

        if (error || !session?.isValid()) {
          clearLegacySessionCache();
          setSessionInfo(null);
          setCurrentUserEmail("");
          setIsChatOpen(false);
          setActiveChat(null);
          setChatDraft("");
          setChatError("");
          setIsCreatingChat(false);
          setIsSendingChatMessage(false);
          chatSessionGenerationRef.current += 1;
          chatSessionCreationInFlightRef.current = false;
          chatSubmissionInFlightRef.current = false;
          pendingChatRequestRef.current = null;
          setAuthStatus("anonymous");
          return;
        }

        const restoredSessionInfo = extractSessionInfo(session);
        const restoredEmail =
          restoredSessionInfo.email || currentUser.getUsername();
        setSessionInfo(restoredSessionInfo);
        setCurrentUserEmail(restoredEmail);
        setSignInValues((previous) => ({
          ...previous,
          email: restoredEmail,
        }));
        setAuthStatus("authenticated");
      });
    };

    restoreSession();

    return () => {
      isMounted = false;
    };
  }, []);

  const chatMessageCount = activeChat?.messages.length || 0;

  useEffect(() => {
    if (!isChatOpen) {
      return undefined;
    }

    const scrollFrame = requestAnimationFrame(() => {
      const chatLog = chatLogRef.current;
      if (chatLog) {
        chatLog.scrollTop = chatLog.scrollHeight;
      }
    });

    return () => cancelAnimationFrame(scrollFrame);
  }, [
    chatError,
    chatMessageCount,
    isChatOpen,
    isCreatingChat,
    isSendingChatMessage,
  ]);

  useEffect(() => {
    if (!isSignInModalOpen) {
      return undefined;
    }

    const focusFrame = requestAnimationFrame(() => {
      authPanelRef.current?.querySelector("[data-autofocus]")?.focus();
    });

    return () => cancelAnimationFrame(focusFrame);
  }, [authView, isSignInModalOpen]);

  useEffect(() => {
    if (!isAdminOrdersOpen) {
      return undefined;
    }

    const clockInterval = window.setInterval(() => {
      setAdminOrderClock(getCurrentTimestamp());
    }, 30_000);

    return () => window.clearInterval(clockInterval);
  }, [isAdminOrdersOpen]);

  useEffect(() => {
    if (
      !isAdminOrdersOpen ||
      !adminOrderStatusNotice ||
      !shouldFocusAdminOrderStatusNotice.current
    ) {
      return undefined;
    }

    shouldFocusAdminOrderStatusNotice.current = false;
    const focusFrame = requestAnimationFrame(() => {
      adminOrderStatusNoticeRef.current?.focus();
    });

    return () => cancelAnimationFrame(focusFrame);
  }, [adminOrderStatusNotice, isAdminOrdersOpen]);

  const isAuthenticated = authStatus === "authenticated";
  const canEditMenu = isAuthenticated && hasAdminAccess(sessionInfo);
  const isOrderingPaused = !orderingStatus.acceptingOrders;
  const isOrderingStatusLoading =
    orderingStatusRequestState === "unknown" ||
    orderingStatusRequestState === "loading";
  const isOrderingStatusError = orderingStatusRequestState === "error";
  const isOrderingStatusUnavailable = Boolean(
    orderingStatusApiUrl && orderingStatusRequestState !== "ready",
  );
  const isOrderingBlocked = isOrderingActionBlocked({
    apiConfigured: Boolean(orderingStatusApiUrl),
    requestState: orderingStatusRequestState,
    acceptingOrders: orderingStatus.acceptingOrders,
  });
  const orderingPausedMessage = getOrderingPausedMessage(
    orderingStatus.message,
  );
  const orderingStatusUnavailableMessage = isOrderingStatusError
    ? "We could not confirm whether online ordering is available. Try checking again."
    : "Checking whether online ordering is available.";
  const pickupFailureDialogOrder = pickupFailureDialog
    ? adminOrders.find(
        (order) => order.orderId === pickupFailureDialog.orderId,
      ) || null
    : null;
  const pickupFailureDialogPickupTime =
    pickupFailureDialogOrder &&
    isCanonicalIsoTimestamp(pickupFailureDialogOrder.pickupTime)
      ? pickupFailureDialogOrder.pickupTime
      : "";
  const isPickupFailureSubmitting = Boolean(
    pickupFailureDialog?.orderId &&
      adminOrderStatusUpdating[pickupFailureDialog.orderId],
  );
  const isAdminSignIn = signInPurpose === "admin";
  const isChatSignIn = signInPurpose === "chat";
  const isOrderSignIn = signInPurpose === "order";
  const isAuthBusy =
    isSigningIn ||
    isSigningUp ||
    isConfirming ||
    isResendingCode ||
    isRequestingPasswordReset ||
    isResettingPassword;
  const cartLineItems = menuItems.flatMap((item) => {
    const quantity = cartQuantities[item.id] || 0;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return [];
    }

    const unitPriceCents = getPriceCents(item.price);
    return [
      {
        item,
        quantity,
        unitPriceCents,
        lineTotalCents: unitPriceCents * quantity,
      },
    ];
  });
  const cartItemCount = cartLineItems.reduce(
    (total, { quantity }) => total + quantity,
    0,
  );
  const cartSubtotalCents = cartLineItems.reduce(
    (total, { lineTotalCents }) => total + lineTotalCents,
    0,
  );
  const cartHasUnavailableItems = cartLineItems.some(
    ({ item }) => item.availability === "out",
  );

  const openSignIn = (purpose) => {
    setSignInPurpose(purpose);
    setAuthView("signIn");
    setSignInErrors({});
    setSignUpErrors({});
    setConfirmationErrors({});
    setPasswordResetErrors({});
    setSignInError("");
    setAuthMessage("");
    setAuthNotice("");
    setShowPassword(false);
    setSignUpValues(initialSignUpValues);
    setConfirmationValues(initialConfirmationValues);
    setPasswordResetValues(initialPasswordResetValues);
    setIsChatOpen(false);
    setIsSignInModalOpen(true);
  };

  const openAdminLogin = () => {
    if (isAuthenticated) {
      if (!canEditMenu) {
        setAuthNotice(
          "This signed-in account does not have menu management access.",
        );
      }
      return;
    }

    openSignIn("admin");
  };

  const openAdminWorkspace = () => {
    if (authStatus === "restoring") {
      return;
    }

    if (!isAuthenticated) {
      openAdminLogin();
      return;
    }

    if (!canEditMenu) {
      setAuthNotice(
        "This signed-in account does not have administration access.",
      );
      return;
    }

    setAuthNotice("");
    setIsAdminWorkspaceOpen(true);
  };

  const closeAdminWorkspace = () => {
    setIsAdminWorkspaceOpen(false);
  };

  const openCustomerSignIn = () => {
    if (authStatus === "restoring" || isAuthenticated) {
      return;
    }

    openSignIn("customer");
  };

  const openChat = () => {
    if (authStatus === "restoring") {
      return;
    }

    if (!isAuthenticated) {
      openSignIn("chat");
      return;
    }

    setAuthNotice("");
    setIsChatOpen(true);
    if (!activeChat && !chatSessionCreationInFlightRef.current) {
      void startNewChat();
    }
  };

  const closeSignIn = () => {
    if (!isAuthBusy) {
      setIsSignInModalOpen(false);
      setAuthView("signIn");
      setSignInError("");
      setAuthMessage("");
      setSignInErrors({});
      setSignUpErrors({});
      setConfirmationErrors({});
      setPasswordResetErrors({});
      setSignInValues((previous) => ({ ...previous, password: "" }));
      setSignUpValues(initialSignUpValues);
      setConfirmationValues(initialConfirmationValues);
      setPasswordResetValues(initialPasswordResetValues);
      setShowPassword(false);
    }
  };

  const showSignUp = () => {
    const currentEmail = signInValues.email.trim().toLowerCase();
    setAuthView("signUp");
    setSignUpValues({
      ...initialSignUpValues,
      email: emailPattern.test(currentEmail) ? currentEmail : "",
    });
    setSignInValues((previous) => ({ ...previous, password: "" }));
    setSignInErrors({});
    setSignUpErrors({});
    setConfirmationErrors({});
    setPasswordResetErrors({});
    setPasswordResetValues(initialPasswordResetValues);
    setSignInError("");
    setAuthMessage("");
    setShowPassword(false);
  };

  const showConfirmation = (email = "") => {
    const nextEmail =
      email.trim().toLowerCase() ||
      signUpValues.email.trim().toLowerCase() ||
      signInValues.email.trim().toLowerCase();
    setAuthView("confirm");
    setConfirmationValues({ email: nextEmail, code: "" });
    setSignInValues((previous) => ({ ...previous, password: "" }));
    setSignUpValues((previous) => ({
      ...previous,
      password: "",
      confirmPassword: "",
    }));
    setSignInErrors({});
    setSignUpErrors({});
    setConfirmationErrors({});
    setPasswordResetErrors({});
    setPasswordResetValues(initialPasswordResetValues);
    setSignInError("");
    setAuthMessage(
      nextEmail
        ? `Enter the confirmation code sent to ${nextEmail}.`
        : "Enter your email and confirmation code.",
    );
    setShowPassword(false);
  };

  const showForgotPassword = (email) => {
    const suppliedEmail =
      typeof email === "string" ? email.trim().toLowerCase() : "";
    const nextEmail = emailPattern.test(suppliedEmail) ? suppliedEmail : "";

    setAuthView("forgotPassword");
    setPasswordResetValues({
      ...initialPasswordResetValues,
      email: nextEmail,
    });
    setSignInValues((previous) => ({ ...previous, password: "" }));
    setSignUpValues((previous) => ({
      ...previous,
      password: "",
      confirmPassword: "",
    }));
    setConfirmationValues(initialConfirmationValues);
    setSignInErrors({});
    setSignUpErrors({});
    setConfirmationErrors({});
    setPasswordResetErrors({});
    setSignInError("");
    setAuthMessage("");
    setShowPassword(false);
  };

  const showSignIn = () => {
    const nextEmail =
      passwordResetValues.email.trim().toLowerCase() ||
      confirmationValues.email.trim().toLowerCase() ||
      signUpValues.email.trim().toLowerCase() ||
      signInValues.email.trim().toLowerCase();
    setAuthView("signIn");
    setSignInValues({ email: nextEmail, password: "" });
    setSignUpValues(initialSignUpValues);
    setConfirmationValues(initialConfirmationValues);
    setSignInErrors({});
    setSignUpErrors({});
    setConfirmationErrors({});
    setPasswordResetErrors({});
    setPasswordResetValues(initialPasswordResetValues);
    setSignInError("");
    setAuthMessage("");
    setShowPassword(false);
  };

  const handleSignInChange = (event) => {
    const { name, value } = event.target;
    setSignInValues((previous) => ({ ...previous, [name]: value }));
    setSignInErrors((previous) => {
      if (!previous[name]) {
        return previous;
      }
      const nextErrors = { ...previous };
      delete nextErrors[name];
      return nextErrors;
    });
    setSignInError("");
    setAuthMessage("");
  };

  const handleSignUpChange = (event) => {
    const { name, value } = event.target;
    setSignUpValues((previous) => ({ ...previous, [name]: value }));
    setSignUpErrors((previous) => {
      if (!previous[name]) {
        return previous;
      }
      const nextErrors = { ...previous };
      delete nextErrors[name];
      return nextErrors;
    });
    setSignInError("");
    setAuthMessage("");
  };

  const handleConfirmationChange = (event) => {
    const { name, value } = event.target;
    setConfirmationValues((previous) => ({ ...previous, [name]: value }));
    setConfirmationErrors((previous) => {
      if (!previous[name]) {
        return previous;
      }
      const nextErrors = { ...previous };
      delete nextErrors[name];
      return nextErrors;
    });
    setSignInError("");
    setAuthMessage("");
  };

  const handlePasswordResetChange = (event) => {
    const { name, value } = event.target;
    setPasswordResetValues((previous) => ({ ...previous, [name]: value }));
    setPasswordResetErrors((previous) => {
      if (!previous[name]) {
        return previous;
      }
      const nextErrors = { ...previous };
      delete nextErrors[name];
      return nextErrors;
    });
    setSignInError("");
    setAuthMessage("");
  };

  const completeSignIn = (session, user, email) => {
    const nextSessionInfo = extractSessionInfo(session);

    if (isAdminSignIn && !hasAdminAccess(nextSessionInfo)) {
      user.signOut();
      throw new Error("This account does not have menu management access.");
    }

    clearLegacySessionCache();
    setSessionInfo(nextSessionInfo);
    setCurrentUserEmail(nextSessionInfo.email || email);
    setAuthStatus("authenticated");
    setAuthNotice(
      isAdminSignIn
        ? "Admin session active. Menu editing is now available."
        : isChatSignIn
          ? "Signed in. Opening your chat."
          : isOrderSignIn
            ? "Signed in. Review your pickup order to continue."
            : "Signed in to your customer account.",
    );
    setSignInValues({ email, password: "" });
    setSignUpValues(initialSignUpValues);
    setConfirmationValues(initialConfirmationValues);
    setPasswordResetValues(initialPasswordResetValues);
    setPasswordResetErrors({});
    setAuthMessage("");
    setIsSignInModalOpen(false);

    if (isChatSignIn) {
      setActiveChat(null);
      setChatDraft("");
      setChatError("");
      setIsChatOpen(true);
      void startNewChat();
    }

    if (isOrderSignIn) {
      setPickupValues((previous) => ({
        ...previous,
        name: previous.name || nextSessionInfo.name,
        phoneNumber: previous.phoneNumber || nextSessionInfo.phoneNumber,
      }));
      setPickupErrors({});
      setOrderError("");
      setOrderView("cart");
      setIsOrderOpen(true);
      if (orderingStatusApiUrl) {
        refreshOrderingStatus().catch(() => {
          // The reopened cart exposes the shared unavailable state and retry.
        });
      }
    }
  };

  const handleSignInSubmit = async (event) => {
    event.preventDefault();
    const nextErrors = validateSignIn(signInValues);
    setSignInErrors(nextErrors);
    setSignInError("");
    setAuthMessage("");

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    try {
      setIsSigningIn(true);
      const email = signInValues.email.trim().toLowerCase();
      const { session, user } = await signInUser(signInValues);
      completeSignIn(session, user, email);
    } catch (error) {
      if (error?.code === "UserNotConfirmedException") {
        showConfirmation(signInValues.email);
      } else if (error?.code === "PasswordResetRequiredException") {
        showForgotPassword(signInValues.email);
        setAuthMessage("Reset your password to continue.");
      } else {
        setSignInError(getSignInErrorMessage(error));
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignUpSubmit = async (event) => {
    event.preventDefault();
    const nextErrors = validateSignUp(signUpValues);
    setSignUpErrors(nextErrors);
    setSignInError("");
    setAuthMessage("");

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    try {
      setIsSigningUp(true);
      const email = signUpValues.email.trim().toLowerCase();
      const result = await signUpUser(signUpValues);
      setSignInValues({ email, password: "" });
      setSignUpValues({ ...initialSignUpValues, email });

      if (result?.userConfirmed) {
        setAuthView("signIn");
        setAuthMessage("Account created. Sign in to continue.");
      } else {
        setAuthView("confirm");
        setConfirmationValues({ email, code: "" });
        setAuthMessage(`We sent a 6-digit confirmation code to ${email}.`);
      }
    } catch (error) {
      setSignInError(getSignUpErrorMessage(error));
    } finally {
      setIsSigningUp(false);
    }
  };

  const handleConfirmationSubmit = async (event) => {
    event.preventDefault();
    const nextErrors = validateConfirmation(confirmationValues);
    setConfirmationErrors(nextErrors);
    setSignInError("");
    setAuthMessage("");

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    try {
      setIsConfirming(true);
      const email = confirmationValues.email.trim().toLowerCase();
      await confirmUserRegistration(email, confirmationValues.code);
      setSignInValues({ email, password: "" });
      setSignUpValues(initialSignUpValues);
      setConfirmationValues(initialConfirmationValues);
      setConfirmationErrors({});
      setAuthView("signIn");
      setAuthMessage("Email confirmed. Sign in to continue.");
    } catch (error) {
      setSignInError(getConfirmationErrorMessage(error));
    } finally {
      setIsConfirming(false);
    }
  };

  const handleResendConfirmationCode = async () => {
    const email = confirmationValues.email.trim().toLowerCase();
    setSignInError("");
    setAuthMessage("");

    if (!email || !emailPattern.test(email)) {
      setConfirmationErrors((previous) => ({
        ...previous,
        email: email ? "Enter a valid email address." : "Email is required.",
      }));
      return;
    }

    try {
      setIsResendingCode(true);
      await resendUserConfirmationCode(email);
      setConfirmationErrors((previous) => {
        const nextErrors = { ...previous };
        delete nextErrors.email;
        return nextErrors;
      });
      setAuthMessage(`A new confirmation code was sent to ${email}.`);
    } catch (error) {
      setSignInError(getConfirmationErrorMessage(error));
    } finally {
      setIsResendingCode(false);
    }
  };

  const showPasswordResetCodeEntry = (email) => {
    setAuthView("resetPassword");
    setPasswordResetValues({
      ...initialPasswordResetValues,
      email: email.trim().toLowerCase(),
    });
    setPasswordResetErrors({});
    setSignInError("");
    setAuthMessage(PASSWORD_RESET_CODE_MESSAGE);
    setShowPassword(false);
  };

  const sendPasswordResetCode = async (email) => {
    try {
      setIsRequestingPasswordReset(true);
      await requestUserPasswordReset(email);
      showPasswordResetCodeEntry(email);
    } catch (error) {
      if (
        error?.code === "UserNotFoundException" ||
        error?.code === "InvalidParameterException" ||
        error?.code === "NotAuthorizedException"
      ) {
        showPasswordResetCodeEntry(email);
      } else {
        setSignInError(getPasswordResetErrorMessage(error));
      }
    } finally {
      setIsRequestingPasswordReset(false);
    }
  };

  const handlePasswordResetRequest = async (event) => {
    event.preventDefault();
    const nextErrors = validatePasswordResetRequest(passwordResetValues);
    setPasswordResetErrors(nextErrors);
    setSignInError("");
    setAuthMessage("");

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    await sendPasswordResetCode(
      passwordResetValues.email.trim().toLowerCase(),
    );
  };

  const handleResendPasswordResetCode = async () => {
    const email = passwordResetValues.email.trim().toLowerCase();
    setSignInError("");
    setAuthMessage("");

    if (!email || !emailPattern.test(email)) {
      setPasswordResetErrors((previous) => ({
        ...previous,
        email: email ? "Enter a valid email address." : "Email is required.",
      }));
      setAuthView("forgotPassword");
      return;
    }

    await sendPasswordResetCode(email);
  };

  const handlePasswordResetSubmit = async (event) => {
    event.preventDefault();
    const nextErrors = validatePasswordReset(passwordResetValues);
    setPasswordResetErrors(nextErrors);
    setSignInError("");
    setAuthMessage("");

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    try {
      setIsResettingPassword(true);
      const email = passwordResetValues.email.trim().toLowerCase();
      await confirmUserPasswordReset(
        email,
        passwordResetValues.code,
        passwordResetValues.password,
      );
      setAuthView("signIn");
      setSignInValues({ email, password: "" });
      setSignUpValues(initialSignUpValues);
      setConfirmationValues(initialConfirmationValues);
      setPasswordResetValues(initialPasswordResetValues);
      setSignInErrors({});
      setSignUpErrors({});
      setConfirmationErrors({});
      setPasswordResetErrors({});
      setAuthMessage(
        "Password reset successfully. Sign in with your new password.",
      );
      setShowPassword(false);
    } catch (error) {
      setSignInError(getPasswordResetErrorMessage(error));
    } finally {
      setIsResettingPassword(false);
    }
  };

  const resetAdminOrderStatusControls = ({ abortRequests = false } = {}) => {
    adminOrderStatusUpdateGeneration.current += 1;
    adminPickupFailureHistoryGeneration.current += 1;

    if (abortRequests) {
      adminOrderStatusRequests.current.forEach((controller) =>
        controller.abort(),
      );
      adminOrderStatusRequests.current.clear();
      adminPickupFailureHistoryRequests.current.forEach((controller) =>
        controller.abort(),
      );
      adminPickupFailureHistoryRequests.current.clear();
    }

    setAdminOrderStatusSelections({});
    setAdminOrderStatusDetails({});
    setAdminOrderStatusErrors({});
    setAdminOrderStatusUpdating({});
    setAdminOrderStatusNotice(null);
    shouldFocusAdminOrderStatusNotice.current = false;
    setPickupFailureDialog(null);
    setAdminPickupFailureHistories({});
  };

  const clearCustomerOrderHistory = () => {
    customerOrdersLoadSequence.current += 1;
    setIsCustomerOrdersOpen(false);
    setCustomerOrders([]);
    setCustomerOrdersNextToken("");
    setCustomerOrdersError("");
    setIsLoadingCustomerOrders(false);
  };

  const handleSignOut = () => {
    try {
      const userPool = createUserPool();
      userPool.getCurrentUser()?.signOut();
    } catch {
      // Local state is still cleared if Cognito sign-out cannot run.
    }

    clearLegacySessionCache();
    setSessionInfo(null);
    setCurrentUserEmail("");
    setAuthStatus("anonymous");
    setIsSignInModalOpen(false);
    setAuthView("signIn");
    editorLoadSequence.current += 1;
    setIsLoadingEditor(false);
    clearPendingDishImages();
    setIsEditorOpen(false);
    setDraftMenuItems([]);
    setIsChatOpen(false);
    setActiveChat(null);
    setChatDraft("");
    setChatError("");
    setIsCreatingChat(false);
    setIsSendingChatMessage(false);
    chatSessionGenerationRef.current += 1;
    chatSessionCreationInFlightRef.current = false;
    chatSubmissionInFlightRef.current = false;
    pendingChatRequestRef.current = null;
    setIsOrderOpen(false);
    setOrderView("cart");
    setPickupValues(initialPickupValues);
    setPickupErrors({});
    setOrderError("");
    setOrderConfirmation(null);
    setIsAdminWorkspaceOpen(false);
    adminOrdersLoadSequence.current += 1;
    setIsAdminOrdersOpen(false);
    setAdminOrders([]);
    setAdminOrdersNextToken("");
    setAdminOrdersError("");
    setIsLoadingAdminOrders(false);
    resetAdminOrderStatusControls({ abortRequests: true });
    announcementsLoadSequence.current += 1;
    setIsAnnouncementsOpen(false);
    setAdminAnnouncements([]);
    setIsLoadingAnnouncements(false);
    setAnnouncementError("");
    setAnnouncementNotice("");
    setAnnouncementForm(createAnnouncementFormValues());
    setAnnouncementFormErrors({});
    setEditingAnnouncementId("");
    setAnnouncementMutation("");
    clearCustomerOrderHistory();
    setSignInValues(initialSignInValues);
    setSignUpValues(initialSignUpValues);
    setConfirmationValues(initialConfirmationValues);
    setSignInErrors({});
    setSignUpErrors({});
    setConfirmationErrors({});
    setSignInError("");
    setAuthMessage("");
    setShowPassword(false);
    setAuthNotice("You have signed out.");
  };

  const startNewChat = async () => {
    if (
      chatSessionCreationInFlightRef.current ||
      chatSubmissionInFlightRef.current
    ) {
      return;
    }

    const requestGeneration = chatSessionGenerationRef.current + 1;
    chatSessionGenerationRef.current = requestGeneration;
    chatSessionCreationInFlightRef.current = true;
    setIsCreatingChat(true);
    setChatError("");

    try {
      if (!chatSessionsApiUrl) {
        throw new Error(
          "The chat API is not configured. Set VITE_API_BASE_URL and restart the app.",
        );
      }

      const freshSessionInfo = await getCurrentSessionInfo();
      const response = await fetch(chatSessionsApiUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: freshSessionInfo.idToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const responseText = await response.text();
      let payload = {};

      if (responseText) {
        try {
          payload = JSON.parse(responseText);
        } catch {
          throw new Error("The chat API returned an invalid response.");
        }
      }

      if (!response.ok) {
        throw new Error(
          getChatApiError(payload, "A new chat could not be started."),
        );
      }

      const nextChat = normalizeChatSession(payload);
      if (chatSessionGenerationRef.current !== requestGeneration) {
        return;
      }

      setSessionInfo(freshSessionInfo);
      setActiveChat(nextChat);
      setChatDraft("");
      pendingChatRequestRef.current = null;
    } catch (error) {
      if (chatSessionGenerationRef.current === requestGeneration) {
        setChatError(error?.message || "A new chat could not be started.");
      }
    } finally {
      if (chatSessionGenerationRef.current === requestGeneration) {
        chatSessionCreationInFlightRef.current = false;
        setIsCreatingChat(false);
      }
    }
  };

  const handleChatSubmit = async (event) => {
    event.preventDefault();
    const content = chatDraft.trim();

    if (
      !content ||
      !isAuthenticated ||
      !activeChat?.id ||
      isCreatingChat ||
      chatSessionCreationInFlightRef.current ||
      chatSubmissionInFlightRef.current
    ) {
      return;
    }

    const requestGeneration = chatSessionGenerationRef.current;
    const chatId = activeChat.id;
    const pendingRequest = pendingChatRequestRef.current;
    const requestId =
      pendingRequest?.chatId === chatId && pendingRequest.content === content
        ? pendingRequest.requestId
        : createChatRequestId();
    pendingChatRequestRef.current = { chatId, content, requestId };
    chatSubmissionInFlightRef.current = true;
    setIsSendingChatMessage(true);
    setChatError("");
    setChatDraft("");

    try {
      if (!chatSessionsApiUrl) {
        throw new Error(
          "The chat API is not configured. Set VITE_API_BASE_URL and restart the app.",
        );
      }

      const freshSessionInfo = await getCurrentSessionInfo();
      const response = await fetch(
        `${chatSessionsApiUrl}/${encodeURIComponent(chatId)}/messages`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: freshSessionInfo.idToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: content,
            requestId,
          }),
        },
      );
      const responseText = await response.text();
      let payload = {};

      if (responseText) {
        try {
          payload = JSON.parse(responseText);
        } catch {
          throw new Error("The chat API returned an invalid response.");
        }
      }

      if (!response.ok) {
        throw new Error(
          getChatApiError(payload, "Your message could not be sent."),
        );
      }

      const userMessage = normalizeChatMessage(payload?.userMessage);
      const assistantMessage = normalizeChatMessage(payload?.assistantMessage);
      if (userMessage.role !== "user" || assistantMessage.role !== "assistant") {
        throw new Error("The chat API returned messages with invalid roles.");
      }

      if (chatSessionGenerationRef.current !== requestGeneration) {
        return;
      }

      setSessionInfo(freshSessionInfo);
      setActiveChat((currentChat) => {
        if (currentChat?.id !== chatId) {
          return currentChat;
        }

        return {
          ...currentChat,
          messages: [
            ...currentChat.messages,
            userMessage,
            assistantMessage,
          ],
        };
      });
      pendingChatRequestRef.current = null;
    } catch (error) {
      if (chatSessionGenerationRef.current === requestGeneration) {
        setChatError(error?.message || "Your message could not be sent.");
        setChatDraft((currentDraft) => currentDraft || content);
      }
    } finally {
      if (chatSessionGenerationRef.current === requestGeneration) {
        chatSubmissionInFlightRef.current = false;
        setIsSendingChatMessage(false);
      }
    }
  };

  const openOrderCart = () => {
    setOrderView("cart");
    setOrderError("");
    setOrderConfirmation(null);
    setIsOrderOpen(true);
    if (orderingStatusApiUrl) {
      refreshOrderingStatus().catch(() => {
        // The open cart renders the shared unavailable state and retry action.
      });
    }
  };

  const closeOrder = () => {
    if (isSubmittingOrder) {
      return;
    }

    setIsOrderOpen(false);
    setOrderView("cart");
    setPickupErrors({});
    setOrderError("");
    setOrderConfirmation(null);
  };

  const loadAdminOrders = async ({ append = false, nextToken = "" } = {}) => {
    if (authStatus === "restoring" || isLoadingAdminOrders) {
      return;
    }

    if (!append) {
      resetAdminOrderStatusControls({ abortRequests: true });
      setAdminOrderClock(getCurrentTimestamp());
    }

    if (!isAuthenticated) {
      openAdminLogin();
      return;
    }

    if (!canEditMenu) {
      setAuthNotice("This signed-in account does not have order management access.");
      return;
    }

    if (!ordersApiUrl) {
      setAdminOrdersError(
        "The orders API is not configured. Set VITE_API_BASE_URL and restart the app.",
      );
      return;
    }

    const loadSequence = adminOrdersLoadSequence.current + 1;
    adminOrdersLoadSequence.current = loadSequence;

    try {
      setIsLoadingAdminOrders(true);
      setAdminOrdersError("");

      const freshSessionInfo = await getCurrentSessionInfo();
      if (!hasAdminAccess(freshSessionInfo)) {
        throw new Error("This account does not have order management access.");
      }

      const requestUrl = new URL(ordersApiUrl);
      requestUrl.searchParams.set("limit", "25");
      if (nextToken) {
        requestUrl.searchParams.set("nextToken", nextToken);
      }

      const response = await fetch(requestUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: freshSessionInfo.idToken,
        },
        cache: "no-store",
      });

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("The orders API returned an invalid response.");
      }

      if (!response.ok) {
        throw new Error(
          payload?.error?.message || "The restaurant orders could not be loaded.",
        );
      }

      if (!Array.isArray(payload?.orders)) {
        throw new Error("The orders API returned an invalid order list.");
      }

      if (adminOrdersLoadSequence.current !== loadSequence) {
        return;
      }

      setSessionInfo(freshSessionInfo);
      setAdminOrders((currentOrders) => {
        const nextOrders = append
          ? [...currentOrders, ...payload.orders]
          : payload.orders;
        const seenOrderIds = new Set();

        return nextOrders.filter((order) => {
          if (
            !order ||
            typeof order.orderId !== "string" ||
            seenOrderIds.has(order.orderId)
          ) {
            return false;
          }

          seenOrderIds.add(order.orderId);
          return true;
        });
      });
      setAdminOrdersNextToken(
        typeof payload.nextToken === "string" ? payload.nextToken : "",
      );
    } catch (error) {
      if (adminOrdersLoadSequence.current === loadSequence) {
        setAdminOrdersError(
          error?.message || "The restaurant orders could not be loaded.",
        );
      }
    } finally {
      if (adminOrdersLoadSequence.current === loadSequence) {
        setIsLoadingAdminOrders(false);
      }
    }
  };

  const openAdminOrders = () => {
    if (authStatus === "restoring" || isLoadingAdminOrders) {
      return;
    }

    if (!isAuthenticated) {
      openAdminLogin();
      return;
    }

    if (!canEditMenu) {
      setAuthNotice("This signed-in account does not have order management access.");
      return;
    }

    setAdminOrderClock(getCurrentTimestamp());
    setIsAdminOrdersOpen(true);
    loadAdminOrders();
    refreshOrderingStatus().catch(() => {
      // The admin control exposes the shared unavailable state and retry action.
    });
  };

  const closeAdminOrders = () => {
    adminOrdersLoadSequence.current += 1;
    setIsLoadingAdminOrders(false);
    setAdminOrdersError("");
    resetAdminOrderStatusControls({ abortRequests: true });
    setIsAdminOrdersOpen(false);
  };

  const refreshAdminOrdersWorkspace = () => {
    loadAdminOrders();
    refreshOrderingStatus().catch(() => {
      // Order history refreshes independently from the status error state.
    });
  };

  const updateAdminOrderingStatus = async (acceptingOrders) => {
    if (isUpdatingAdminOrderingStatus || authStatus === "restoring") {
      return;
    }

    if (typeof acceptingOrders !== "boolean") {
      return;
    }

    if (!isAuthenticated) {
      openAdminLogin();
      return;
    }

    if (!canEditMenu) {
      setAuthNotice(
        "This signed-in account does not have order management access.",
      );
      return;
    }

    if (!adminOrderingStatusApiUrl) {
      shouldFocusAdminOrderStatusNotice.current = true;
      setAdminOrderStatusNotice({
        type: "error",
        message:
          "The ordering status API is not configured. Set VITE_API_BASE_URL and restart the app.",
      });
      return;
    }

    if (isOrderingStatusUnavailable) {
      shouldFocusAdminOrderStatusNotice.current = true;
      setAdminOrderStatusNotice({
        type: "error",
        message:
          "Check the current ordering status before changing it.",
      });
      return;
    }

    const statusWasPaused = isOrderingPaused;
    const action = acceptingOrders
      ? "resume"
      : statusWasPaused
        ? "save"
        : "pause";
    const pauseMessage = adminOrderingPauseMessage.trim();
    if (!acceptingOrders && !pauseMessage) {
      shouldFocusAdminOrderStatusNotice.current = true;
      setAdminOrderStatusNotice({
        type: "error",
        message: "Enter a customer-facing message before pausing orders.",
      });
      return;
    }

    if (pauseMessage.length > MAX_ORDERING_STATUS_MESSAGE_LENGTH) {
      shouldFocusAdminOrderStatusNotice.current = true;
      setAdminOrderStatusNotice({
        type: "error",
        message: `The pause message must not exceed ${MAX_ORDERING_STATUS_MESSAGE_LENGTH} characters.`,
      });
      return;
    }

    try {
      setIsUpdatingAdminOrderingStatus(true);
      setAdminOrderingStatusAction(action);
      setAdminOrderStatusNotice(null);

      const freshSessionInfo = await getCurrentSessionInfo();
      if (!hasAdminAccess(freshSessionInfo)) {
        throw new Error("This account does not have order management access.");
      }

      const savedStatus = await requestOrderingStatus({
        url: adminOrderingStatusApiUrl,
        idToken: freshSessionInfo.idToken,
        method: "PUT",
        statusUpdate: {
          acceptingOrders,
          ...(!acceptingOrders ? { message: pauseMessage } : {}),
        },
      });

      if (savedStatus.acceptingOrders !== acceptingOrders) {
        throw new Error(
          "The ordering status API did not confirm the requested change.",
        );
      }

      setSessionInfo(freshSessionInfo);
      setOrderingStatus(savedStatus);
      setOrderingStatusRequestState("ready");
      if (!savedStatus.acceptingOrders) {
        setAdminOrderingPauseMessage(savedStatus.message);
      }

      try {
        await refreshOrderingStatus();
      } catch (refreshError) {
        if (refreshError?.name !== "AbortError") {
          // The successful PUT response is authoritative even if its public re-read fails.
          setOrderingStatus(savedStatus);
          setOrderingStatusRequestState("ready");
        }
      }

      shouldFocusAdminOrderStatusNotice.current = true;
      setAdminOrderStatusNotice({
        type: "success",
        message: acceptingOrders
          ? "Online ordering is accepting orders again."
          : statusWasPaused
            ? "The paused-ordering message was updated."
            : "Online ordering is paused. Customers now see your message.",
      });
    } catch (error) {
      shouldFocusAdminOrderStatusNotice.current = true;
      setAdminOrderStatusNotice({
        type: "error",
        message:
          error?.message || "The ordering status could not be updated.",
      });
    } finally {
      setIsUpdatingAdminOrderingStatus(false);
      setAdminOrderingStatusAction("");
    }
  };

  const selectAdminOrderStatus = (orderId, nextStatus) => {
    const currentOrder = adminOrders.find((order) => order.orderId === orderId);
    const currentStatus = normalizeOrderStatus(currentOrder?.status);
    const allowedStatuses = ORDER_STATUS_TRANSITIONS[currentStatus] || [];

    if (nextStatus && !allowedStatuses.includes(nextStatus)) {
      return;
    }

    setAdminOrderStatusSelections((currentSelections) => ({
      ...currentSelections,
      [orderId]: nextStatus,
    }));
    setAdminOrderStatusDetails((currentDetails) => ({
      ...currentDetails,
      [orderId]: {
        pickupTimeLocal:
          nextStatus === "CONFIRMED"
            ? currentDetails[orderId]?.pickupTimeLocal || ""
            : "",
        restaurantNote:
          currentDetails[orderId]?.restaurantNote || "",
      },
    }));
    setAdminOrderStatusErrors((currentErrors) => {
      const nextErrors = { ...currentErrors };
      delete nextErrors[orderId];
      return nextErrors;
    });
  };

  const changeAdminOrderStatusDetail = (orderId, field, value) => {
    if (!["pickupTimeLocal", "restaurantNote"].includes(field)) {
      return;
    }

    setAdminOrderStatusDetails((currentDetails) => ({
      ...currentDetails,
      [orderId]: {
        pickupTimeLocal:
          currentDetails[orderId]?.pickupTimeLocal || "",
        restaurantNote:
          currentDetails[orderId]?.restaurantNote || "",
        [field]: value,
      },
    }));
    setAdminOrderStatusErrors((currentErrors) => {
      if (!currentErrors[orderId]?.[field]) {
        return currentErrors;
      }

      const nextOrderErrors = { ...currentErrors[orderId] };
      delete nextOrderErrors[field];
      return {
        ...currentErrors,
        [orderId]: nextOrderErrors,
      };
    });
  };

  const updateAdminOrderStatus = async (orderId) => {
    if (!isAuthenticated || !canEditMenu) {
      setAuthNotice(
        "This signed-in account does not have order management access.",
      );
      return;
    }

    if (!ordersApiUrl || adminOrderStatusRequests.current.has(orderId)) {
      return;
    }

    const currentOrder = adminOrders.find((order) => order.orderId === orderId);
    const currentStatus = normalizeOrderStatus(currentOrder?.status);
    const nextStatus = adminOrderStatusSelections[orderId] || "";
    const allowedStatuses = ORDER_STATUS_TRANSITIONS[currentStatus] || [];
    const statusDetails = adminOrderStatusDetails[orderId] || {};

    if (!currentOrder || !allowedStatuses.includes(nextStatus)) {
      setAdminOrderStatusNotice({
        type: "error",
        message:
          "Choose a valid next status for this order before updating it.",
      });
      return;
    }

    const validationErrors = {};
    const restaurantNote =
      typeof statusDetails.restaurantNote === "string"
        ? statusDetails.restaurantNote.trim()
        : "";
    let pickupTime = "";
    let pickupTimeHasPassed = false;

    if (restaurantNote.length > MAX_RESTAURANT_NOTE_LENGTH) {
      validationErrors.restaurantNote =
        `The note must not exceed ${MAX_RESTAURANT_NOTE_LENGTH} characters.`;
    }

    if (nextStatus === "CONFIRMED") {
      const pickupTimeLocal =
        typeof statusDetails.pickupTimeLocal === "string"
          ? statusDetails.pickupTimeLocal.trim()
          : "";
      const pickupDate = new Date(pickupTimeLocal);

      if (!pickupTimeLocal) {
        validationErrors.pickupTimeLocal =
          "Choose a pickup date and time.";
      } else if (Number.isNaN(pickupDate.getTime())) {
        validationErrors.pickupTimeLocal =
          "Choose a valid pickup date and time.";
      } else {
        pickupTime = pickupDate.toISOString();
        pickupTimeHasPassed =
          pickupDate.getTime() <= getCurrentTimestamp();
      }
    }

    if (Object.keys(validationErrors).length > 0) {
      setAdminOrderStatusErrors((currentErrors) => ({
        ...currentErrors,
        [orderId]: validationErrors,
      }));
      setAdminOrderStatusNotice({
        type: "error",
        message:
          "Check the pickup time and customer note before updating this order.",
      });
      return;
    }

    setAdminOrderStatusErrors((currentErrors) => {
      const nextErrors = { ...currentErrors };
      delete nextErrors[orderId];
      return nextErrors;
    });

    const confirmationDetails = [
      nextStatus === "CONFIRMED"
        ? `Pickup time: ${formatPickupTime(pickupTime)}`
        : "",
      pickupTimeHasPassed
        ? "This pickup time has passed. It will be accepted only if this is an exact retry of a confirmation already saved."
        : "",
      restaurantNote ? `Customer note: ${restaurantNote}` : "",
    ].filter(Boolean);
    const confirmed = window.confirm(
      `Change order ${orderId} from ${formatStatusLabel(
        currentStatus,
      )} to ${formatStatusLabel(
        nextStatus,
      )}?${
        confirmationDetails.length > 0
          ? `\n\n${confirmationDetails.join("\n")}`
          : ""
      }\n\nThis status change is irreversible and cannot be undone. Confirm the order details before continuing.`,
    );

    if (!confirmed) {
      return;
    }

    const updateGeneration = adminOrderStatusUpdateGeneration.current;
    const controller = new AbortController();
    adminOrderStatusRequests.current.set(orderId, controller);
    setAdminOrderStatusNotice(null);
    setAdminOrderStatusUpdating((currentUpdating) => ({
      ...currentUpdating,
      [orderId]: true,
    }));

    try {
      const freshSessionInfo = await getCurrentSessionInfo();
      if (!hasAdminAccess(freshSessionInfo)) {
        throw new Error(
          "This account no longer has order management access.",
        );
      }

      const requestBody = {
        status: nextStatus,
        expectedStatus: currentStatus,
        restaurantNote,
        ...(nextStatus === "CONFIRMED" ? { pickupTime } : {}),
      };
      const response = await fetch(
        `${ordersApiUrl}/${encodeURIComponent(orderId)}/status`,
        {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            Authorization: freshSessionInfo.idToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        },
      );

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("The orders API returned an invalid response.");
      }

      if (!response.ok) {
        const responseDetails = Array.isArray(payload?.error?.details)
          ? payload.error.details
          : [];
        const fieldErrors = {};
        responseDetails.forEach((detail) => {
          if (
            detail?.field === "pickupTime" &&
            typeof detail.message === "string"
          ) {
            fieldErrors.pickupTimeLocal =
              `Pickup time ${detail.message}.`;
          }
          if (
            detail?.field === "restaurantNote" &&
            typeof detail.message === "string"
          ) {
            fieldErrors.restaurantNote =
              `Customer note ${detail.message}.`;
          }
        });
        if (Object.keys(fieldErrors).length > 0) {
          setAdminOrderStatusErrors((currentErrors) => ({
            ...currentErrors,
            [orderId]: fieldErrors,
          }));
        }

        const error = new Error(
          response.status === 409
            ? `Order ${orderId} changed after this list was loaded. Refresh orders before trying again.`
            : Object.keys(fieldErrors).length > 0
              ? Object.values(fieldErrors).join(" ")
            : payload?.error?.message ||
                "The order status could not be updated.",
        );
        error.status = response.status;
        throw error;
      }

      const responseOrder = payload?.order;
      const savedStatus = normalizeOrderStatus(responseOrder?.status);
      const savedPickupTime =
        typeof responseOrder?.pickupTime === "string"
          ? responseOrder.pickupTime
          : "";
      const savedRestaurantNote =
        typeof responseOrder?.restaurantNote === "string"
          ? responseOrder.restaurantNote.trim()
          : "";
      if (
        !responseOrder ||
        responseOrder.orderId !== orderId ||
        savedStatus !== nextStatus ||
        (nextStatus === "CONFIRMED"
          ? savedPickupTime !== pickupTime
          : Boolean(savedPickupTime)) ||
        savedRestaurantNote !== restaurantNote
      ) {
        throw new Error("The orders API returned an invalid status update.");
      }

      if (
        adminOrderStatusUpdateGeneration.current !== updateGeneration ||
        controller.signal.aborted
      ) {
        return;
      }

      setSessionInfo(freshSessionInfo);
      setAdminOrders((currentOrders) =>
        currentOrders.map((order) => {
          if (order.orderId !== orderId) {
            return order;
          }

          const updatedOrder = {
            ...order,
            status: savedStatus,
            updatedAt:
              typeof responseOrder.updatedAt === "string"
                ? responseOrder.updatedAt
                : order.updatedAt,
          };

          if (savedPickupTime) {
            updatedOrder.pickupTime = savedPickupTime;
          } else {
            delete updatedOrder.pickupTime;
          }

          if (savedRestaurantNote) {
            updatedOrder.restaurantNote = savedRestaurantNote;
          } else {
            delete updatedOrder.restaurantNote;
          }

          return updatedOrder;
        }),
      );
      setAdminOrderStatusSelections((currentSelections) => {
        const nextSelections = { ...currentSelections };
        delete nextSelections[orderId];
        return nextSelections;
      });
      setAdminOrderStatusDetails((currentDetails) => {
        const nextDetails = { ...currentDetails };
        delete nextDetails[orderId];
        return nextDetails;
      });
      setAdminOrderStatusErrors((currentErrors) => {
        const nextErrors = { ...currentErrors };
        delete nextErrors[orderId];
        return nextErrors;
      });
      setAdminOrderStatusNotice({
        type: "success",
        message: `Order ${orderId} changed from ${formatStatusLabel(
          currentStatus,
        )} to ${formatStatusLabel(savedStatus)}.`,
      });
    } catch (error) {
      if (
        error?.name !== "AbortError" &&
        adminOrderStatusUpdateGeneration.current === updateGeneration
      ) {
        setAdminOrderStatusNotice({
          type: "error",
          message:
            error?.message || "The order status could not be updated.",
        });
      }
    } finally {
      if (adminOrderStatusRequests.current.get(orderId) === controller) {
        adminOrderStatusRequests.current.delete(orderId);
      }

      if (adminOrderStatusUpdateGeneration.current === updateGeneration) {
        setAdminOrderStatusUpdating((currentUpdating) => {
          const nextUpdating = { ...currentUpdating };
          delete nextUpdating[orderId];
          return nextUpdating;
        });
      }
    }
  };

  const closePickupFailureDialog = () => {
    const orderId = pickupFailureDialog?.orderId;
    if (orderId && adminOrderStatusUpdating[orderId]) {
      return;
    }

    setPickupFailureDialog(null);
  };

  const openPickupFailureDialog = (orderId) => {
    const currentOrder = adminOrders.find((order) => order.orderId === orderId);
    const currentStatus = normalizeOrderStatus(currentOrder?.status);
    const pickupTime =
      typeof currentOrder?.pickupTime === "string"
        ? currentOrder.pickupTime
        : "";

    if (
      !currentOrder ||
      currentStatus !== "CONFIRMED" ||
      !isCanonicalIsoTimestamp(pickupTime)
    ) {
      setAdminOrderStatusNotice({
        type: "error",
        message:
          "This order does not have a valid confirmed pickup time. Refresh the order list before trying again.",
      });
      return;
    }

    if (adminOrderStatusRequests.current.has(orderId)) {
      return;
    }

    setPickupFailureDialog({
      orderId,
      restaurantNote: "",
      error: "",
    });
  };

  const changePickupFailureNote = (value) => {
    setPickupFailureDialog((currentDialog) =>
      currentDialog
        ? {
            ...currentDialog,
            restaurantNote: value,
            error: "",
          }
        : currentDialog,
    );
  };

  const markAdminOrderFailedToPickup = async () => {
    const orderId = pickupFailureDialog?.orderId || "";
    const restaurantNote =
      typeof pickupFailureDialog?.restaurantNote === "string"
        ? pickupFailureDialog.restaurantNote.trim()
        : "";

    if (!isAuthenticated || !canEditMenu) {
      setPickupFailureDialog((currentDialog) =>
        currentDialog
          ? {
              ...currentDialog,
              error:
                "This signed-in account does not have order management access.",
            }
          : currentDialog,
      );
      return;
    }

    if (
      !ordersApiUrl ||
      !orderId ||
      adminOrderStatusRequests.current.has(orderId)
    ) {
      return;
    }

    if (restaurantNote.length > MAX_RESTAURANT_NOTE_LENGTH) {
      setPickupFailureDialog((currentDialog) =>
        currentDialog
          ? {
              ...currentDialog,
              error: `The message must not exceed ${MAX_RESTAURANT_NOTE_LENGTH} characters.`,
            }
          : currentDialog,
      );
      return;
    }

    const currentOrder = adminOrders.find((order) => order.orderId === orderId);
    const currentStatus = normalizeOrderStatus(currentOrder?.status);
    const pickupTime =
      typeof currentOrder?.pickupTime === "string"
        ? currentOrder.pickupTime
        : "";

    if (
      !currentOrder ||
      currentStatus !== "CONFIRMED" ||
      !isCanonicalIsoTimestamp(pickupTime)
    ) {
      setPickupFailureDialog((currentDialog) =>
        currentDialog
          ? {
              ...currentDialog,
              error:
                "This order is no longer eligible. Refresh the order list and check its status and pickup time.",
            }
          : currentDialog,
      );
      return;
    }

    const updateGeneration = adminOrderStatusUpdateGeneration.current;
    const controller = new AbortController();
    adminOrderStatusRequests.current.set(orderId, controller);
    setAdminOrderStatusNotice(null);
    setAdminOrderStatusUpdating((currentUpdating) => ({
      ...currentUpdating,
      [orderId]: true,
    }));
    setPickupFailureDialog((currentDialog) =>
      currentDialog ? { ...currentDialog, error: "" } : currentDialog,
    );

    try {
      const freshSessionInfo = await getCurrentSessionInfo();
      if (!hasAdminAccess(freshSessionInfo)) {
        throw new Error(
          "This account no longer has order management access.",
        );
      }

      const response = await fetch(
        `${ordersApiUrl}/${encodeURIComponent(orderId)}/status`,
        {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            Authorization: freshSessionInfo.idToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            status: "FAILED_TO_PICKUP",
            expectedStatus: "CONFIRMED",
            restaurantNote,
          }),
          signal: controller.signal,
        },
      );

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("The orders API returned an invalid response.");
      }

      if (!response.ok) {
        const error = new Error(
          response.status === 409
            ? `Order ${orderId} changed after this list was loaded. Refresh orders before trying again.`
            : payload?.error?.message ||
                "The order could not be marked as not picked up.",
        );
        error.status = response.status;
        throw error;
      }

      const responseOrder = payload?.order;
      const savedStatus = normalizeOrderStatus(responseOrder?.status);
      const savedRestaurantNote =
        typeof responseOrder?.restaurantNote === "string"
          ? responseOrder.restaurantNote.trim()
          : "";

      if (
        !responseOrder ||
        responseOrder.orderId !== orderId ||
        savedStatus !== "FAILED_TO_PICKUP" ||
        Object.hasOwn(responseOrder, "pickupTime") ||
        responseOrder.scheduledPickupTime !== pickupTime ||
        !isCanonicalIsoTimestamp(responseOrder.scheduledPickupTime) ||
        !isCanonicalIsoTimestamp(responseOrder.failedToPickupAt) ||
        !isCanonicalIsoTimestamp(responseOrder.updatedAt) ||
        savedRestaurantNote !== restaurantNote
      ) {
        throw new Error("The orders API returned an invalid status update.");
      }

      if (
        adminOrderStatusUpdateGeneration.current !== updateGeneration ||
        controller.signal.aborted
      ) {
        return;
      }

      setSessionInfo(freshSessionInfo);
      setAdminOrders((currentOrders) =>
        currentOrders.map((order) => {
          if (order.orderId !== orderId) {
            return order;
          }

          const updatedOrder = {
            ...order,
            status: savedStatus,
            scheduledPickupTime: responseOrder.scheduledPickupTime,
            failedToPickupAt: responseOrder.failedToPickupAt,
            updatedAt: responseOrder.updatedAt,
          };
          delete updatedOrder.pickupTime;

          if (savedRestaurantNote) {
            updatedOrder.restaurantNote = savedRestaurantNote;
          } else {
            delete updatedOrder.restaurantNote;
          }

          return updatedOrder;
        }),
      );
      setAdminOrderStatusSelections((currentSelections) => {
        const nextSelections = { ...currentSelections };
        delete nextSelections[orderId];
        return nextSelections;
      });
      setAdminOrderStatusDetails((currentDetails) => {
        const nextDetails = { ...currentDetails };
        delete nextDetails[orderId];
        return nextDetails;
      });
      setAdminOrderStatusErrors((currentErrors) => {
        const nextErrors = { ...currentErrors };
        delete nextErrors[orderId];
        return nextErrors;
      });
      adminPickupFailureHistoryGeneration.current += 1;
      adminPickupFailureHistoryRequests.current.forEach((historyController) =>
        historyController.abort(),
      );
      adminPickupFailureHistoryRequests.current.clear();
      setAdminPickupFailureHistories({});
      setPickupFailureDialog(null);
      shouldFocusAdminOrderStatusNotice.current = true;
      setAdminOrderStatusNotice({
        type: "success",
        message: `Order ${orderId} was marked as not picked up. The customer's failed-pickup history was updated.`,
      });
    } catch (error) {
      if (
        error?.name !== "AbortError" &&
        adminOrderStatusUpdateGeneration.current === updateGeneration
      ) {
        setPickupFailureDialog((currentDialog) =>
          currentDialog?.orderId === orderId
            ? {
                ...currentDialog,
                error:
                  error?.message ||
                  "The order could not be marked as not picked up.",
              }
            : currentDialog,
        );
      }
    } finally {
      if (adminOrderStatusRequests.current.get(orderId) === controller) {
        adminOrderStatusRequests.current.delete(orderId);
      }

      if (adminOrderStatusUpdateGeneration.current === updateGeneration) {
        setAdminOrderStatusUpdating((currentUpdating) => {
          const nextUpdating = { ...currentUpdating };
          delete nextUpdating[orderId];
          return nextUpdating;
        });
      }
    }
  };

  const loadAdminPickupFailureHistory = async (
    orderId,
    { append = false, nextToken = "" } = {},
  ) => {
    if (
      !isAuthenticated ||
      !canEditMenu ||
      !adminOrdersApiUrl ||
      !orderId ||
      adminPickupFailureHistoryRequests.current.has(orderId)
    ) {
      return;
    }

    const historyGeneration = adminPickupFailureHistoryGeneration.current;
    const controller = new AbortController();
    adminPickupFailureHistoryRequests.current.set(orderId, controller);
    setAdminPickupFailureHistories((currentHistories) => ({
      ...currentHistories,
      [orderId]: {
        isOpen: true,
        isLoading: true,
        hasLoaded: currentHistories[orderId]?.hasLoaded || false,
        failedPickupCount:
          currentHistories[orderId]?.failedPickupCount ?? null,
        lastFailedPickupAt:
          currentHistories[orderId]?.lastFailedPickupAt || "",
        lastFailedOrderId:
          currentHistories[orderId]?.lastFailedOrderId || "",
        failures: currentHistories[orderId]?.failures || [],
        nextToken: currentHistories[orderId]?.nextToken || "",
        error: "",
      },
    }));

    try {
      const freshSessionInfo = await getCurrentSessionInfo();
      if (!hasAdminAccess(freshSessionInfo)) {
        throw new Error(
          "This account no longer has order management access.",
        );
      }

      const requestUrl = new URL(
        `${adminOrdersApiUrl}/${encodeURIComponent(
          orderId,
        )}/customer/pickup-failures`,
      );
      requestUrl.searchParams.set(
        "limit",
        String(PICKUP_FAILURE_HISTORY_PAGE_SIZE),
      );
      if (nextToken) {
        requestUrl.searchParams.set("nextToken", nextToken);
      }

      const response = await fetch(requestUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: freshSessionInfo.idToken,
        },
        cache: "no-store",
        signal: controller.signal,
      });

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("The pickup history API returned an invalid response.");
      }

      if (!response.ok) {
        throw new Error(
          payload?.error?.message ||
            "The customer's pickup history could not be loaded.",
        );
      }

      const parsedHistory = parsePickupFailureHistory(payload);
      const existingFailures =
        append &&
        Array.isArray(adminPickupFailureHistories[orderId]?.failures)
          ? adminPickupFailureHistories[orderId].failures
          : [];
      const failureByOrderId = new Map(
        existingFailures.map((failure) => [failure.orderId, failure]),
      );

      parsedHistory.failures.forEach((failure) => {
        const existingFailure = failureByOrderId.get(failure.orderId);
        if (
          existingFailure &&
          (existingFailure.scheduledPickupTime !==
            failure.scheduledPickupTime ||
            existingFailure.failedPickupAt !== failure.failedPickupAt)
        ) {
          throw new Error(
            "The pickup history API returned conflicting history records.",
          );
        }
        failureByOrderId.set(failure.orderId, failure);
      });

      const combinedFailures = Array.from(failureByOrderId.values());
      if (combinedFailures.length > parsedHistory.failedPickupCount) {
        throw new Error("The pickup history API returned an invalid response.");
      }

      if (
        adminPickupFailureHistoryGeneration.current !== historyGeneration ||
        controller.signal.aborted
      ) {
        return;
      }

      setSessionInfo(freshSessionInfo);
      setAdminPickupFailureHistories((currentHistories) => {
        const currentHistory = currentHistories[orderId];
        return {
          ...currentHistories,
          [orderId]: {
            isOpen: currentHistory?.isOpen !== false,
            isLoading: false,
            hasLoaded: true,
            failedPickupCount: parsedHistory.failedPickupCount,
            lastFailedPickupAt: parsedHistory.lastFailedPickupAt,
            lastFailedOrderId: parsedHistory.lastFailedOrderId,
            failures: combinedFailures,
            nextToken: parsedHistory.nextToken,
            error: "",
          },
        };
      });
    } catch (error) {
      if (
        error?.name !== "AbortError" &&
        adminPickupFailureHistoryGeneration.current === historyGeneration
      ) {
        setAdminPickupFailureHistories((currentHistories) => ({
          ...currentHistories,
          [orderId]: {
            isOpen: currentHistories[orderId]?.isOpen !== false,
            isLoading: false,
            hasLoaded: currentHistories[orderId]?.hasLoaded || false,
            failedPickupCount:
              currentHistories[orderId]?.failedPickupCount ?? null,
            lastFailedPickupAt:
              currentHistories[orderId]?.lastFailedPickupAt || "",
            lastFailedOrderId:
              currentHistories[orderId]?.lastFailedOrderId || "",
            failures: currentHistories[orderId]?.failures || [],
            nextToken: currentHistories[orderId]?.nextToken || "",
            error:
              error?.message ||
              "The customer's pickup history could not be loaded.",
          },
        }));
      }
    } finally {
      if (
        adminPickupFailureHistoryRequests.current.get(orderId) === controller
      ) {
        adminPickupFailureHistoryRequests.current.delete(orderId);
      }
    }
  };

  const toggleAdminPickupFailureHistory = (orderId) => {
    const currentHistory = adminPickupFailureHistories[orderId];
    const shouldOpen = !currentHistory?.isOpen;

    setAdminPickupFailureHistories((currentHistories) => ({
      ...currentHistories,
      [orderId]: {
        isOpen: shouldOpen,
        isLoading: currentHistories[orderId]?.isLoading || false,
        hasLoaded: currentHistories[orderId]?.hasLoaded || false,
        failedPickupCount:
          currentHistories[orderId]?.failedPickupCount ?? null,
        lastFailedPickupAt:
          currentHistories[orderId]?.lastFailedPickupAt || "",
        lastFailedOrderId:
          currentHistories[orderId]?.lastFailedOrderId || "",
        failures: currentHistories[orderId]?.failures || [],
        nextToken: currentHistories[orderId]?.nextToken || "",
        error: currentHistories[orderId]?.error || "",
      },
    }));

    if (
      shouldOpen &&
      !currentHistory?.hasLoaded &&
      !currentHistory?.isLoading
    ) {
      loadAdminPickupFailureHistory(orderId);
    }
  };

  const loadCustomerOrders = async ({
    append = false,
    nextToken = "",
  } = {}) => {
    if (authStatus === "restoring" || isLoadingCustomerOrders) {
      return;
    }

    if (!isAuthenticated || canEditMenu) {
      return;
    }

    if (!ordersApiUrl) {
      setCustomerOrdersError(
        "The orders API is not configured. Set VITE_API_BASE_URL and restart the app.",
      );
      return;
    }

    const loadSequence = customerOrdersLoadSequence.current + 1;
    customerOrdersLoadSequence.current = loadSequence;

    try {
      setIsLoadingCustomerOrders(true);
      setCustomerOrdersError("");

      const freshSessionInfo = await getCurrentSessionInfo();
      if (hasAdminAccess(freshSessionInfo)) {
        setSessionInfo(freshSessionInfo);
        throw new Error(
          "Admin accounts can view restaurant orders from the Orders workspace.",
        );
      }

      const requestUrl = new URL(`${ordersApiUrl}/mine`);
      requestUrl.searchParams.set("limit", "25");
      if (nextToken) {
        requestUrl.searchParams.set("nextToken", nextToken);
      }

      const response = await fetch(requestUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: freshSessionInfo.idToken,
        },
        cache: "no-store",
      });

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("The orders API returned an invalid response.");
      }

      if (!response.ok) {
        throw new Error(
          payload?.error?.message || "Your order history could not be loaded.",
        );
      }

      if (!Array.isArray(payload?.orders)) {
        throw new Error("The orders API returned an invalid order list.");
      }

      if (customerOrdersLoadSequence.current !== loadSequence) {
        return;
      }

      setSessionInfo(freshSessionInfo);
      setCustomerOrders((currentOrders) => {
        const nextOrders = append
          ? [...currentOrders, ...payload.orders]
          : payload.orders;
        const seenOrderIds = new Set();

        return nextOrders.filter((order) => {
          if (
            !order ||
            typeof order.orderId !== "string" ||
            seenOrderIds.has(order.orderId)
          ) {
            return false;
          }

          seenOrderIds.add(order.orderId);
          return true;
        });
      });
      setCustomerOrdersNextToken(
        typeof payload.nextToken === "string" ? payload.nextToken : "",
      );
    } catch (error) {
      if (customerOrdersLoadSequence.current === loadSequence) {
        setCustomerOrdersError(
          error?.message || "Your order history could not be loaded.",
        );
      }
    } finally {
      if (customerOrdersLoadSequence.current === loadSequence) {
        setIsLoadingCustomerOrders(false);
      }
    }
  };

  const openCustomerOrders = () => {
    if (
      authStatus === "restoring" ||
      isLoadingCustomerOrders ||
      !isAuthenticated ||
      canEditMenu
    ) {
      return;
    }

    setIsCustomerOrdersOpen(true);
    loadCustomerOrders();
  };

  const closeCustomerOrders = () => {
    customerOrdersLoadSequence.current += 1;
    setIsLoadingCustomerOrders(false);
    setCustomerOrdersError("");
    setIsCustomerOrdersOpen(false);
  };

  const addDishToCart = (item) => {
    if (isOrderingBlocked || item.availability !== "available") {
      return;
    }

    setCartQuantities((previous) => {
      const currentQuantity = previous[item.id] || 0;
      if (currentQuantity >= MAX_ORDER_QUANTITY) {
        return previous;
      }

      return {
        ...previous,
        [item.id]: currentQuantity + 1,
      };
    });
    setOrderError("");
    setOrderConfirmation(null);
  };

  const changeCartQuantity = (dishId, difference) => {
    const dish = menuItems.find((item) => item.id === dishId);
    if (
      !dish ||
      (difference > 0 &&
        (isOrderingBlocked || dish.availability !== "available"))
    ) {
      return;
    }

    setCartQuantities((previous) => {
      const currentQuantity = previous[dishId] || 0;
      const nextQuantity = Math.min(
        MAX_ORDER_QUANTITY,
        currentQuantity + difference,
      );

      if (nextQuantity <= 0) {
        const nextQuantities = { ...previous };
        delete nextQuantities[dishId];
        return nextQuantities;
      }

      return {
        ...previous,
        [dishId]: nextQuantity,
      };
    });
    setOrderError("");
    setOrderConfirmation(null);
  };

  const removeCartItem = (dishId) => {
    setCartQuantities((previous) => {
      const nextQuantities = { ...previous };
      delete nextQuantities[dishId];
      return nextQuantities;
    });
    setOrderError("");
    setOrderConfirmation(null);
  };

  const beginPickupCheckout = () => {
    setOrderError("");

    if (isOrderingStatusUnavailable) {
      setOrderError(orderingStatusUnavailableMessage);
      return;
    }

    if (isOrderingPaused) {
      setOrderError(orderingPausedMessage);
      return;
    }

    if (cartLineItems.length === 0) {
      setOrderError("Add at least one available dish before checkout.");
      return;
    }

    if (cartHasUnavailableItems) {
      setOrderError(
        "Remove sold-out dishes from your order before checkout.",
      );
      return;
    }

    if (ordersApiUrl && menuDataStatus !== "live") {
      setOrderError(
        "The live menu is unavailable, so this order cannot be sent. Reload the page and try again.",
      );
      return;
    }

    setPickupValues((previous) => ({
      ...previous,
      name: previous.name || sessionInfo?.name || "",
      phoneNumber: previous.phoneNumber || sessionInfo?.phoneNumber || "",
    }));
    setPickupErrors({});
    setOrderView("checkout");
  };

  const handlePickupChange = (event) => {
    const { name, value } = event.target;
    setPickupValues((previous) => ({ ...previous, [name]: value }));
    setPickupErrors((previous) => {
      if (!previous[name]) {
        return previous;
      }

      const nextErrors = { ...previous };
      delete nextErrors[name];
      return nextErrors;
    });
    setOrderError("");
  };

  const handleOrderSubmit = async (event) => {
    event.preventDefault();

    if (orderSubmissionInFlightRef.current) {
      return;
    }

    if (isOrderingStatusUnavailable) {
      setOrderView("cart");
      setOrderError(orderingStatusUnavailableMessage);
      return;
    }

    if (isOrderingPaused) {
      setOrderView("cart");
      setOrderError(orderingPausedMessage);
      return;
    }

    const nextErrors = validatePickup(pickupValues);
    setPickupErrors(nextErrors);
    setOrderError("");

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    if (cartLineItems.length === 0) {
      setOrderView("cart");
      setOrderError("Add at least one available dish before checkout.");
      return;
    }

    if (cartHasUnavailableItems) {
      setOrderView("cart");
      setOrderError(
        "Remove sold-out dishes from your order before checkout.",
      );
      return;
    }

    if (ordersApiUrl && menuDataStatus !== "live") {
      setOrderError(
        "The live menu is unavailable, so this order cannot be sent. Reload the page and try again.",
      );
      return;
    }

    if (!isAuthenticated) {
      setIsOrderOpen(false);
      openSignIn("order");
      return;
    }

    orderSubmissionInFlightRef.current = true;
    setIsSubmittingOrder(true);

    try {
      const freshSessionInfo = await getCurrentSessionInfo();
      const normalizedPickupValues = {
        name: pickupValues.name.trim(),
        phoneNumber: normalizePhoneNumber(pickupValues.phoneNumber),
      };
      const orderRequest = {
        clientRequestId: orderClientRequestId,
        items: cartLineItems.map(({ item, quantity }) => ({
          dishId: item.id,
          quantity,
        })),
        fulfillment: "pickup",
        pickupContact: normalizedPickupValues,
        customerNote: pickupValues.note.trim(),
      };
      const confirmationSnapshot = {
        itemCount: cartItemCount,
        subtotalCents: cartSubtotalCents,
        pickupContact: normalizedPickupValues,
      };

      setSessionInfo(freshSessionInfo);

      if (!ordersApiUrl) {
        setOrderConfirmation({
          type: "preview",
          reference: orderClientRequestId,
          ...confirmationSnapshot,
        });
        setOrderView("confirmation");
        return;
      }

      if (menuDataStatus !== "live") {
        throw new Error(
          "The live menu is unavailable, so this order cannot be sent. Reload the page and try again.",
        );
      }

      const response = await fetch(ordersApiUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: freshSessionInfo.idToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(orderRequest),
      });
      const responseText = await response.text();
      let payload = {};

      if (responseText) {
        try {
          payload = JSON.parse(responseText);
        } catch {
          if (!response.ok) {
            throw new Error("The order API returned an invalid response.");
          }
        }
      }

      if (!response.ok) {
        if (payload?.error?.code === "ORDERING_PAUSED") {
          const pausedMessage = getOrderingPausedMessage(
            payload?.error?.message,
          );
          setOrderingStatus((currentStatus) => ({
            ...currentStatus,
            acceptingOrders: false,
            message: pausedMessage,
          }));
          setOrderingStatusRequestState("ready");
          setOrderView("cart");
          refreshOrderingStatus().catch((refreshError) => {
            if (refreshError?.name !== "AbortError") {
              // The 503 response is authoritative even if its public re-read fails.
              setOrderingStatus((currentStatus) => ({
                ...currentStatus,
                acceptingOrders: false,
                message: pausedMessage,
              }));
              setOrderingStatusRequestState("ready");
            }
          });
          throw new Error(pausedMessage);
        }

        const details = Array.isArray(payload?.error?.details)
          ? payload.error.details
              .map(({ field, message }) => `${field}: ${message}`)
              .join("; ")
          : "";
        throw new Error(
          details ||
            payload?.error?.message ||
            payload?.message ||
            "The pickup order could not be sent.",
        );
      }

      setOrderConfirmation({
        type: "submitted",
        reference:
          (typeof payload?.orderId === "string" && payload.orderId) ||
          (typeof payload?.id === "string" && payload.id) ||
          orderClientRequestId,
        ...confirmationSnapshot,
      });
      setCartQuantities({});
      setOrderClientRequestId(createUniqueId("order"));
      clearCustomerOrderHistory();
      setOrderView("confirmation");
    } catch (error) {
      setOrderError(error?.message || "The pickup order could not be sent.");
    } finally {
      orderSubmissionInFlightRef.current = false;
      setIsSubmittingOrder(false);
    }
  };

  const refreshPublicAnnouncements = async () => {
    if (!announcementsApiUrl) {
      return;
    }

    try {
      const announcements = await requestAnnouncementList({
        url: announcementsApiUrl,
      });
      setPublicAnnouncements(announcements);
    } catch {
      // Keep the last good public list; announcements never block the menu.
    }
  };

  const loadAdminAnnouncements = async () => {
    if (isLoadingAnnouncements) {
      return;
    }

    if (!privateAnnouncementsApiUrl) {
      setAnnouncementError(
        "The announcements API is not configured. Set VITE_API_BASE_URL and restart the app.",
      );
      return;
    }

    const loadSequence = announcementsLoadSequence.current + 1;
    announcementsLoadSequence.current = loadSequence;

    try {
      setIsLoadingAnnouncements(true);
      setAnnouncementError("");
      const freshSessionInfo = await getCurrentSessionInfo();

      if (!hasAdminAccess(freshSessionInfo)) {
        throw new Error(
          "This account does not have announcement management access.",
        );
      }

      const announcements = await requestAnnouncementList({
        url: privateAnnouncementsApiUrl,
        idToken: freshSessionInfo.idToken,
        requireAdminFields: true,
      });

      if (announcementsLoadSequence.current !== loadSequence) {
        return;
      }

      setSessionInfo(freshSessionInfo);
      setAdminAnnouncements(announcements);
      setEditingAnnouncementId((currentId) => {
        if (!currentId) {
          return "";
        }

        const latest = announcements.find(
          ({ announcementId }) => announcementId === currentId,
        );
        if (latest) {
          setAnnouncementForm(createAnnouncementFormValues(latest));
          return currentId;
        }

        setAnnouncementForm(createAnnouncementFormValues());
        return "";
      });
    } catch (error) {
      if (announcementsLoadSequence.current === loadSequence) {
        setAnnouncementError(
          error?.message || "Announcements could not be loaded.",
        );
      }
    } finally {
      if (announcementsLoadSequence.current === loadSequence) {
        setIsLoadingAnnouncements(false);
      }
    }
  };

  const openAnnouncementsAdmin = () => {
    if (authStatus === "restoring" || isLoadingAnnouncements) {
      return;
    }

    if (!isAuthenticated) {
      openAdminLogin();
      return;
    }

    if (!canEditMenu) {
      setAuthNotice(
        "This signed-in account does not have announcement management access.",
      );
      return;
    }

    setAnnouncementForm(createAnnouncementFormValues());
    setAnnouncementFormErrors({});
    setEditingAnnouncementId("");
    setAnnouncementError("");
    setAnnouncementNotice("");
    setIsAnnouncementsOpen(true);
    loadAdminAnnouncements();
  };

  const closeAnnouncementsAdmin = () => {
    if (announcementMutation) {
      return;
    }

    announcementsLoadSequence.current += 1;
    setIsLoadingAnnouncements(false);
    setIsAnnouncementsOpen(false);
    setAnnouncementFormErrors({});
    setAnnouncementError("");
    setAnnouncementNotice("");
  };

  const startNewAnnouncement = () => {
    setEditingAnnouncementId("");
    setAnnouncementForm(createAnnouncementFormValues());
    setAnnouncementFormErrors({});
    setAnnouncementError("");
    setAnnouncementNotice("");
  };

  const editAnnouncement = (announcement) => {
    setEditingAnnouncementId(announcement.announcementId);
    setAnnouncementForm(createAnnouncementFormValues(announcement));
    setAnnouncementFormErrors({});
    setAnnouncementError("");
    setAnnouncementNotice("");
  };

  const updateAnnouncementForm = (field, value) => {
    setAnnouncementForm((currentValues) => ({
      ...currentValues,
      [field]: value,
      ...(field === "type" && value !== "DISCOUNT"
        ? { promoCode: "" }
        : {}),
    }));
    setAnnouncementFormErrors((currentErrors) => {
      if (!currentErrors[field] && field !== "type") {
        return currentErrors;
      }

      const nextErrors = { ...currentErrors };
      delete nextErrors[field];
      if (field === "type") {
        delete nextErrors.promoCode;
      }
      return nextErrors;
    });
    setAnnouncementError("");
    setAnnouncementNotice("");
  };

  const handleSaveAnnouncement = async (event) => {
    event.preventDefault();
    if (announcementMutation) {
      return;
    }

    const errors = validateAnnouncementForm(announcementForm);
    if (Object.keys(errors).length > 0) {
      setAnnouncementFormErrors(errors);
      setAnnouncementError("Review the highlighted announcement fields.");
      setAnnouncementNotice("");
      return;
    }

    if (!announcementsApiUrl) {
      setAnnouncementError(
        "The announcements API is not configured. Set VITE_API_BASE_URL and restart the app.",
      );
      return;
    }

    const currentAnnouncement = editingAnnouncementId
      ? adminAnnouncements.find(
          ({ announcementId }) =>
            announcementId === editingAnnouncementId,
        )
      : null;
    if (editingAnnouncementId && !currentAnnouncement) {
      setAnnouncementError(
        "This announcement is no longer in the loaded list. Refresh and try again.",
      );
      return;
    }

    setAnnouncementMutation("save");
    setAnnouncementError("");
    setAnnouncementNotice("");

    try {
      const freshSessionInfo = await getCurrentSessionInfo();
      if (!hasAdminAccess(freshSessionInfo)) {
        throw new Error(
          "This account does not have announcement management access.",
        );
      }

      const response = await fetch(
        currentAnnouncement
          ? `${announcementsApiUrl}/${encodeURIComponent(
              currentAnnouncement.announcementId,
            )}`
          : announcementsApiUrl,
        {
          method: currentAnnouncement ? "PATCH" : "POST",
          headers: {
            Accept: "application/json",
            Authorization: freshSessionInfo.idToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...toAnnouncementRequest(announcementForm),
            ...(currentAnnouncement
              ? { expectedUpdatedAt: currentAnnouncement.updatedAt }
              : {}),
          }),
        },
      );

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("The announcements API returned an invalid response.");
      }

      if (!response.ok) {
        if (response.status === 409) {
          throw new Error(
            "This announcement changed after you loaded it. Refresh the list before trying again.",
          );
        }
        throw new Error(
          getAnnouncementApiError(
            payload,
            currentAnnouncement
              ? "The announcement could not be updated."
              : "The announcement could not be created.",
          ),
        );
      }

      const savedAnnouncement = normalizeAnnouncement(payload?.announcement, {
        requireAdminFields: true,
      });
      if (!savedAnnouncement) {
        throw new Error(
          "The announcements API returned invalid announcement data.",
        );
      }

      setSessionInfo(freshSessionInfo);
      setAdminAnnouncements((currentAnnouncements) =>
        [
          ...currentAnnouncements.filter(
            ({ announcementId }) =>
              announcementId !== savedAnnouncement.announcementId,
          ),
          savedAnnouncement,
        ].sort(compareAnnouncements),
      );
      setEditingAnnouncementId(savedAnnouncement.announcementId);
      setAnnouncementForm(createAnnouncementFormValues(savedAnnouncement));
      setAnnouncementFormErrors({});
      setAnnouncementNotice(
        currentAnnouncement
          ? "Announcement updated."
          : "Announcement created.",
      );
      await refreshPublicAnnouncements();
    } catch (error) {
      setAnnouncementError(
        error?.message || "The announcement could not be saved.",
      );
    } finally {
      setAnnouncementMutation("");
    }
  };

  const deleteAnnouncement = async (announcement) => {
    if (
      announcementMutation ||
      !window.confirm(
        `Delete “${announcement.title}”? This cannot be undone.`,
      )
    ) {
      return;
    }

    setAnnouncementMutation(`delete:${announcement.announcementId}`);
    setAnnouncementError("");
    setAnnouncementNotice("");

    try {
      const freshSessionInfo = await getCurrentSessionInfo();
      if (!hasAdminAccess(freshSessionInfo)) {
        throw new Error(
          "This account does not have announcement management access.",
        );
      }

      const response = await fetch(
        `${announcementsApiUrl}/${encodeURIComponent(
          announcement.announcementId,
        )}`,
        {
          method: "DELETE",
          headers: {
            Accept: "application/json",
            Authorization: freshSessionInfo.idToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            expectedUpdatedAt: announcement.updatedAt,
          }),
        },
      );

      if (!response.ok) {
        let payload = {};
        try {
          payload = await response.json();
        } catch {
          // Preserve the status-specific fallback for empty error responses.
        }

        if (response.status === 409) {
          throw new Error(
            "This announcement changed after you loaded it. Refresh the list before deleting it.",
          );
        }
        throw new Error(
          getAnnouncementApiError(
            payload,
            "The announcement could not be deleted.",
          ),
        );
      }

      setSessionInfo(freshSessionInfo);
      setAdminAnnouncements((currentAnnouncements) =>
        currentAnnouncements.filter(
          ({ announcementId }) =>
            announcementId !== announcement.announcementId,
        ),
      );
      if (editingAnnouncementId === announcement.announcementId) {
        setEditingAnnouncementId("");
        setAnnouncementForm(createAnnouncementFormValues());
        setAnnouncementFormErrors({});
      }
      setAnnouncementNotice("Announcement deleted.");
      await refreshPublicAnnouncements();
    } catch (error) {
      setAnnouncementError(
        error?.message || "The announcement could not be deleted.",
      );
    } finally {
      setAnnouncementMutation("");
    }
  };

  const openMenuEditor = async () => {
    if (authStatus === "restoring" || isLoadingEditor) {
      return;
    }

    if (!isAuthenticated) {
      openAdminLogin();
      return;
    }

    if (!canEditMenu) {
      setAuthNotice(
        "This signed-in account does not have menu management access.",
      );
      return;
    }

    if (!privateDishesApiUrl) {
      clearPendingDishImages();
      setDraftMenuItems(cloneMenuItems(menuItems));
      setEditorError("");
      setMenuNotice("");
      setIsEditorOpen(true);
      return;
    }

    const loadSequence = editorLoadSequence.current + 1;
    editorLoadSequence.current = loadSequence;

    try {
      setIsLoadingEditor(true);
      setAuthNotice("");
      const freshSessionInfo = await getCurrentSessionInfo();

      if (!hasAdminAccess(freshSessionInfo)) {
        throw new Error("This account does not have menu management access.");
      }

      const response = await fetch(privateDishesApiUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: freshSessionInfo.idToken,
        },
        cache: "no-store",
      });

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("The private menu API returned an invalid response.");
      }

      if (!response.ok) {
        throw new Error(
          payload?.error?.message || "The private menu could not be loaded.",
        );
      }

      const privateItems = normalizeMenuItems(payload);
      if (editorLoadSequence.current !== loadSequence) {
        return;
      }

      setSessionInfo(freshSessionInfo);
      clearPendingDishImages();
      setDraftMenuItems(
        privateItems.length > 0
          ? cloneMenuItems(privateItems)
          : cloneMenuItems(menuItems),
      );
      setEditorError("");
      setMenuNotice("");
      setIsEditorOpen(true);
    } catch (error) {
      if (editorLoadSequence.current === loadSequence) {
        setAuthNotice(
          error?.message || "The private menu could not be loaded.",
        );
      }
    } finally {
      if (editorLoadSequence.current === loadSequence) {
        setIsLoadingEditor(false);
      }
    }
  };

  const updateDraftItem = (id, field, value) => {
    setDraftMenuItems((items) =>
      items.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
    );
    setEditorError("");
  };

  const toggleDraftAllergen = (id, allergen, isSelected) => {
    setDraftMenuItems((items) =>
      items.map((item) => {
        if (item.id !== id) {
          return item;
        }

        const selectedAllergens = new Set(item.allergens);
        if (isSelected) {
          selectedAllergens.add(allergen);
        } else {
          selectedAllergens.delete(allergen);
        }

        return {
          ...item,
          allergens: ALLERGEN_OPTIONS.map(({ value }) => value).filter(
            (value) => selectedAllergens.has(value),
          ),
        };
      }),
    );
    setEditorError("");
  };

  const handleDraftImageSelection = (dishId, event) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    if (!DISH_IMAGE_CONTENT_TYPES.has(file.type)) {
      setEditorError("Dish images must be JPEG, PNG, or WebP files.");
      return;
    }

    if (file.size <= 0 || file.size > MAX_DISH_IMAGE_SIZE) {
      setEditorError("Dish images must be no larger than 5 MiB.");
      return;
    }

    const item = draftMenuItems.find(({ id }) => id === dishId);
    const previousPendingImage = pendingDishImagesRef.current[dishId];
    const previewUrl = URL.createObjectURL(file);
    replacePendingDishImage(dishId, {
      file,
      previewUrl,
      alt:
        previousPendingImage?.alt ??
        item?.image?.alt ??
        item?.name?.trim() ??
        "",
    });
    setEditorError("");
  };

  const updatePendingDishImageAlt = (dishId, alt) => {
    const pendingImage = pendingDishImagesRef.current[dishId];
    if (!pendingImage) {
      return;
    }

    const nextImages = {
      ...pendingDishImagesRef.current,
      [dishId]: { ...pendingImage, alt },
    };
    pendingDishImagesRef.current = nextImages;
    setPendingDishImages(nextImages);
    setEditorError("");
  };

  const updateDraftDishImageAlt = (dishId, alt) => {
    setDraftMenuItems((items) =>
      items.map((item) =>
        item.id === dishId && item.image
          ? { ...item, image: { ...item.image, alt } }
          : item,
      ),
    );
    setEditorError("");
  };

  const removeDraftDishImage = (dishId) => {
    discardPendingDishImage(dishId);
    setDraftMenuItems((items) =>
      items.map((item) =>
        item.id === dishId ? { ...item, image: null } : item,
      ),
    );
    setEditorError("");
  };

  const closeMenuEditor = () => {
    if (isSavingMenu) {
      return;
    }

    clearPendingDishImages();
    setIsEditorOpen(false);
  };

  const uploadPendingDishImage = async (
    item,
    pendingImage,
    idToken,
  ) => {
    let dimensions;
    try {
      dimensions = await readDishImageDimensions(pendingImage.previewUrl);
    } catch (error) {
      throw new Error(
        `${item.name}: ${error?.message || "The selected image is invalid."}`,
        { cause: error },
      );
    }

    let presignResponse;
    try {
      presignResponse = await fetch(dishImageUploadApiUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: idToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dishId: item.id,
          contentType: pendingImage.file.type,
          size: pendingImage.file.size,
        }),
      });
    } catch (error) {
      throw new Error(
        `${item.name}: the image upload could not be prepared. ${error?.message || "Check the API connection."}`,
        { cause: error },
      );
    }

    let presignPayload;
    try {
      presignPayload = await presignResponse.json();
    } catch {
      throw new Error(
        `${item.name}: the image upload API returned an invalid response.`,
      );
    }

    if (!presignResponse.ok) {
      throw new Error(
        presignPayload?.error?.message ||
          `${item.name}: the image upload could not be prepared.`,
      );
    }

    const uploadUrl = presignPayload?.uploadUrl;
    const uploadHeaders = presignPayload?.uploadHeaders;
    const uploadCacheControl = uploadHeaders?.["Cache-Control"];
    const uploadContentType = uploadHeaders?.["Content-Type"];
    const key =
      typeof presignPayload?.key === "string" ? presignPayload.key.trim() : "";
    const keyMatch = DISH_IMAGE_KEY_PATTERN.exec(key);
    if (
      typeof uploadUrl !== "string" ||
      !uploadUrl ||
      !uploadHeaders ||
      typeof uploadHeaders !== "object" ||
      Array.isArray(uploadHeaders) ||
      uploadContentType !== pendingImage.file.type ||
      typeof uploadCacheControl !== "string" ||
      !uploadCacheControl ||
      !keyMatch ||
      keyMatch[1] !== item.id
    ) {
      throw new Error(
        `${item.name}: the image upload API returned invalid upload details.`,
      );
    }

    let uploadResponse;
    try {
      uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Cache-Control": uploadCacheControl,
          "Content-Type": uploadContentType,
        },
        body: pendingImage.file,
      });
    } catch (error) {
      throw new Error(
        `${item.name}: the image could not be uploaded. ${error?.message || "Check the storage CORS configuration."}`,
        { cause: error },
      );
    }

    if (!uploadResponse.ok) {
      throw new Error(
        `${item.name}: the image upload failed with status ${uploadResponse.status}.`,
      );
    }

    return {
      key,
      width: dimensions.width,
      height: dimensions.height,
    };
  };

  const addDraftItem = () => {
    const id =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `dish-${Date.now()}`;
    setDraftMenuItems((items) => [
      ...items,
      {
        id,
        category: "New course",
        name: "",
        description: "",
        price: "",
        allergens: [],
        fullDishInfo: "",
        image: null,
        availability: "available",
      },
    ]);
    setEditorError("");
  };

  const removeDraftItem = (id) => {
    discardPendingDishImage(id);
    setDraftMenuItems((items) => items.filter((item) => item.id !== id));
    setEditorError("");
  };

  const restoreDraftDefaults = () => {
    clearPendingDishImages();
    setDraftMenuItems(cloneDefaultMenu());
    setEditorError("");
  };

  const handleSaveMenu = async (event) => {
    event.preventDefault();

    if (draftMenuItems.length === 0) {
      setEditorError("Add at least one dish before saving.");
      return;
    }

    const normalizedIds = draftMenuItems.map((item) => item.id.trim());
    const hasDuplicateId = new Set(normalizedIds).size !== normalizedIds.length;
    const hasInvalidItem = draftMenuItems.some((item) => {
      const normalizedPrice = String(Number(item.price));
      const pendingImage = pendingDishImages[item.id];
      const imageKeyMatch = item.image?.key
        ? DISH_IMAGE_KEY_PATTERN.exec(item.image.key.trim())
        : null;
      const hasInvalidSavedImage =
        item.image !== null &&
        item.image !== undefined &&
        (typeof item.image !== "object" ||
          Array.isArray(item.image) ||
          !imageKeyMatch ||
          imageKeyMatch[1] !== item.id.trim() ||
          typeof item.image.alt !== "string" ||
          item.image.alt.trim().length > MAX_DISH_IMAGE_ALT_LENGTH ||
          !Number.isInteger(item.image.width) ||
          item.image.width <= 0 ||
          item.image.width > MAX_DISH_IMAGE_DIMENSION ||
          !Number.isInteger(item.image.height) ||
          item.image.height <= 0 ||
          item.image.height > MAX_DISH_IMAGE_DIMENSION);
      const hasInvalidPendingImage =
        pendingImage &&
        (!DISH_IMAGE_CONTENT_TYPES.has(pendingImage.file?.type) ||
          pendingImage.file.size <= 0 ||
          pendingImage.file.size > MAX_DISH_IMAGE_SIZE ||
          typeof pendingImage.alt !== "string" ||
          pendingImage.alt.trim().length > MAX_DISH_IMAGE_ALT_LENGTH ||
          !pendingImage.previewUrl);

      return (
        !/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(item.id.trim()) ||
        !item.category.trim() ||
        item.category.trim().length > 50 ||
        !item.name.trim() ||
        item.name.trim().length > 120 ||
        !item.description.trim() ||
        item.description.trim().length > 1000 ||
        !Array.isArray(item.allergens) ||
        item.allergens.some(
          (allergen) =>
            typeof allergen !== "string" || !ALLERGEN_VALUES.has(allergen),
        ) ||
        new Set(item.allergens).size !== item.allergens.length ||
        !AVAILABILITY_VALUES.has(item.availability) ||
        typeof item.fullDishInfo !== "string" ||
        item.fullDishInfo.trim().length > MAX_FULL_DISH_INFO_LENGTH ||
        hasInvalidSavedImage ||
        hasInvalidPendingImage ||
        !String(item.price).trim() ||
        !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalizedPrice) ||
        Number(item.price) > 100000
      );
    });

    if (hasInvalidItem || hasDuplicateId) {
      setEditorError(
        "Check every dish, availability, image, allergen selection, private AI note, unique ID, and price before saving.",
      );
      return;
    }

    const cleanedItems = draftMenuItems.map((item) => ({
      id: item.id.trim(),
      category: item.category.trim(),
      name: item.name.trim(),
      description: item.description.trim(),
      price: String(Number(item.price)),
      allergens: ALLERGEN_OPTIONS.map(({ value }) => value).filter(
        (allergen) => item.allergens.includes(allergen),
      ),
      availability: item.availability,
      fullDishInfo: item.fullDishInfo.trim(),
      ...(item.image
        ? {
            image: {
              key: item.image.key.trim(),
              alt: item.image.alt.trim(),
              width: item.image.width,
              height: item.image.height,
            },
          }
        : {}),
    }));

    if (!dishesApiUrl) {
      setEditorError(
        "The menu API is not configured. Set VITE_API_BASE_URL and restart the app.",
      );
      return;
    }

    if (Object.keys(pendingDishImages).length > 0 && !dishImageUploadApiUrl) {
      setEditorError(
        "The dish image upload API is not configured. Set VITE_API_BASE_URL and restart the app.",
      );
      return;
    }

    try {
      setIsSavingMenu(true);
      const freshSessionInfo = await getCurrentSessionInfo();

      if (!hasAdminAccess(freshSessionInfo)) {
        throw new Error("This account does not have menu management access.");
      }

      const itemsToSave = [];
      for (const item of cleanedItems) {
        const pendingImage = pendingDishImagesRef.current[item.id];
        if (!pendingImage) {
          itemsToSave.push(item);
          continue;
        }

        let uploadedImage = pendingImage.uploadedImage;
        if (!uploadedImage) {
          uploadedImage = await uploadPendingDishImage(
            item,
            pendingImage,
            freshSessionInfo.idToken,
          );
          replacePendingDishImage(item.id, {
            ...pendingImage,
            uploadedImage,
          });
        }

        itemsToSave.push({
          ...item,
          image: {
            ...uploadedImage,
            alt: pendingImage.alt.trim(),
          },
        });
      }

      const response = await fetch(dishesApiUrl, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          Authorization: freshSessionInfo.idToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ items: itemsToSave }),
      });

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("The menu API returned an invalid response.");
      }

      if (!response.ok) {
        const details = Array.isArray(payload?.error?.details)
          ? payload.error.details
              .map(({ field, message }) => `${field}: ${message}`)
              .join("; ")
          : "";
        throw new Error(
          details || payload?.error?.message || "The menu could not be saved.",
        );
      }

      const savedItems = normalizeMenuItems(payload?.items);
      if (savedItems.length === 0) {
        throw new Error("The menu API returned an empty menu after saving.");
      }

      setSessionInfo(freshSessionInfo);
      clearPendingDishImages();
      setDraftMenuItems(cloneMenuItems(savedItems));
      setMenuItems(toPublicMenuItems(savedItems));
      setMenuDataStatus("live");
      setMenuNotice("Menu changes saved to DynamoDB.");
      setIsEditorOpen(false);
    } catch (error) {
      setEditorError(error?.message || "The menu could not be saved.");
    } finally {
      setIsSavingMenu(false);
    }
  };

  const openAdminWorkspaceTool = (tool) => {
    setIsAdminWorkspaceOpen(false);

    requestAnimationFrame(() => {
      if (tool === "orders") {
        openAdminOrders();
      } else if (tool === "menu") {
        openMenuEditor();
      } else if (tool === "announcements") {
        openAnnouncementsAdmin();
      }
    });
  };

  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="#top" aria-label="Snowfox home">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-copy">
              <strong>SNOWFOX</strong>
              <small>Japanese kitchen</small>
            </span>
          </a>

          <nav className="primary-nav" aria-label="Main navigation">
            <a href="#menu">Menu</a>
            <a href="#story">Our story</a>
            <a href="#visit">Visit</a>
          </nav>

          <div className="header-actions">
            <button
              type="button"
              className="button button-small button-outline header-order-button"
              onClick={openOrderCart}
              aria-haspopup="dialog"
            >
              Cart
              {cartItemCount > 0 && (
                <span className="header-cart-count" aria-label={`${cartItemCount} items`}>
                  {cartItemCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className="button button-small button-outline header-chat-button"
              onClick={openChat}
              disabled={authStatus === "restoring"}
            >
              Chat
            </button>
            {isAuthenticated ? (
              <>
                <span className="admin-status" title={currentUserEmail}>
                  <span aria-hidden="true" />
                  {canEditMenu ? "Admin" : "Signed in"}
                </span>
                {canEditMenu && (
                  <button
                    type="button"
                    className="button button-small button-dark"
                    onClick={openAdminWorkspace}
                    aria-haspopup="dialog"
                  >
                    Admin workspace
                  </button>
                )}
                {!canEditMenu && (
                  <button
                    type="button"
                    className="button button-small button-outline"
                    onClick={openCustomerOrders}
                    disabled={isLoadingCustomerOrders}
                    aria-haspopup="dialog"
                  >
                    {isLoadingCustomerOrders ? "Loading…" : "My orders"}
                  </button>
                )}
                {!canEditMenu && (
                  <button
                    type="button"
                    className="text-button sign-out-button"
                    onClick={handleSignOut}
                  >
                    Sign out
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="button button-small button-primary"
                  onClick={openCustomerSignIn}
                  disabled={authStatus === "restoring"}
                >
                  {authStatus === "restoring" ? "Checking…" : "Sign in"}
                </button>
                <button
                  type="button"
                  className="admin-button"
                  onClick={openAdminLogin}
                  disabled={authStatus === "restoring"}
                >
                  Admin
                </button>
              </>
            )}
          </div>

          <button
            type="button"
            className="mobile-header-cart-button"
            onClick={openOrderCart}
            aria-haspopup="dialog"
            aria-label={`Open order, ${cartItemCount} ${
              cartItemCount === 1 ? "item" : "items"
            }`}
          >
            <MobileNavIcon name="cart" />
            <span>Cart</span>
            {cartItemCount > 0 && (
              <span className="mobile-header-cart-count" aria-hidden="true">
                {cartItemCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {authNotice && (
        <div className="site-notice" role="status">
          <span>{authNotice}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setAuthNotice("")}
          >
            ×
          </button>
        </div>
      )}

      {isOrderingStatusUnavailable ? (
        <section
          className={`ordering-paused-banner ordering-status-banner-${
            isOrderingStatusError ? "error" : "checking"
          }`}
          role={isOrderingStatusError ? "alert" : "status"}
          aria-labelledby="ordering-status-title"
        >
          <div>
            <div>
              <strong id="ordering-status-title">
                {isOrderingStatusError
                  ? "Online ordering is unavailable"
                  : "Checking online ordering"}
              </strong>
              <p>{orderingStatusUnavailableMessage}</p>
            </div>
            {isOrderingStatusError && (
              <button
                type="button"
                className="ordering-status-retry"
                onClick={() =>
                  refreshOrderingStatus().catch(() => {
                    // The banner remains in its retryable error state.
                  })
                }
              >
                Try again
              </button>
            )}
          </div>
        </section>
      ) : isOrderingPaused ? (
        <section
          className="ordering-paused-banner"
          role="alert"
          aria-labelledby="ordering-paused-title"
        >
          <div>
            <strong id="ordering-paused-title">Online ordering is paused</strong>
            <p>{orderingPausedMessage}</p>
          </div>
        </section>
      ) : null}

      <main>
        {publicAnnouncements.length > 0 && (
          <section
            className="announcement-board"
            aria-labelledby="announcement-board-title"
          >
            <header className="announcement-board-header">
              <p className="eyebrow">Restaurant updates</p>
              <h2 id="announcement-board-title">What’s happening at Snowfox</h2>
            </header>
            <div className="announcement-card-list">
              {publicAnnouncements.map((announcement) => (
                <article
                  className={`announcement-card announcement-card-${announcement.type.toLowerCase()}`}
                  key={announcement.announcementId}
                >
                  <div className="announcement-card-meta">
                    <span>{ANNOUNCEMENT_TYPE_LABELS[announcement.type]}</span>
                    <time dateTime={announcement.startsAt}>
                      {formatAnnouncementWindow(
                        announcement.startsAt,
                        announcement.endsAt,
                      )}
                    </time>
                  </div>
                  <h3>{announcement.title}</h3>
                  <p>{announcement.message}</p>
                  {announcement.type === "DISCOUNT" &&
                    announcement.promoCode && (
                      <div className="announcement-promo">
                        <span>Code</span>
                        <code>{announcement.promoCode}</code>
                      </div>
                    )}
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="hero" id="top">
          <div className="hero-copy">
            <p className="eyebrow">Season-led Japanese dining</p>
            <h1>
              The art of sushi,
              <em> served with soul.</em>
            </h1>
            <p className="hero-description">
              Thoughtful omakase and considered classics, guided by the catch,
              the rice, and the quiet beauty of each season.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#menu">
                Explore the menu
                <span aria-hidden="true">↘</span>
              </a>
              <a className="button button-quiet" href="#visit">
                Find Snowfox
              </a>
            </div>
            <dl className="hero-details">
              <div>
                <dt>Dinner</dt>
                <dd>Tue–Sun, 5–10 pm</dd>
              </div>
            </dl>
          </div>

          <div className="hero-visual" aria-label="Chef selection of sushi">
            <div className="hero-orbit" aria-hidden="true" />
            <div className="hero-image-frame">
              <img
                src={sushiHero}
                srcSet={`${sushiHeroMobile} 720w, ${sushiHero} 960w`}
                sizes="(max-width: 560px) calc(100vw - 44px), (max-width: 820px) calc(100vw - 80px), 560px"
                alt="A chef's selection of salmon and tuna sushi, sashimi, and maki"
                width="960"
                height="1440"
                fetchPriority="high"
                decoding="async"
              />
            </div>
            <p className="image-index" aria-hidden="true">
              SNOWFOX / 01
            </p>
          </div>
        </section>

        <section className="philosophy" aria-labelledby="philosophy-title">
          <p className="vertical-label">Our approach</p>
          <div>
            <p className="eyebrow">Respect for every ingredient</p>
            <h2 id="philosophy-title">
              Tradition at heart.
              <br /> Curiosity in every detail.
            </h2>
          </div>
          <p className="philosophy-copy">
            We source with care, season our rice throughout service, and let
            each ingredient speak clearly. Nothing is added without purpose.
          </p>
        </section>

        <section className="menu-section" id="menu" aria-labelledby="menu-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">À la carte</p>
              <h2 id="menu-title">A taste of Snowfox</h2>
            </div>
            <div className="menu-heading-actions">
              <p>Our menu shifts gently with the market and the season.</p>
            </div>
          </div>

          {menuNotice && (
            <p className="menu-notice" role="status">
              {menuNotice}
            </p>
          )}

          <div className="menu-grid" aria-busy={isMenuLoading}>
            {menuItems.map((item, index) => {
              const imageUrl = getDishImageUrl(item.image);
              const cartQuantity = cartQuantities[item.id] || 0;
              const isSoldOut = item.availability === "out";

              return (
              <article
                className={`menu-card${imageUrl ? " menu-card-with-image" : ""}`}
                key={item.id}
              >
                <div className="menu-card-topline">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div className="menu-card-topline-details">
                    <span>{item.category}</span>
                    <span
                      className={`menu-availability menu-availability-${item.availability}`}
                      aria-label={`Availability: ${
                        item.availability === "out" ? "Out" : "Available"
                      }`}
                    >
                      {item.availability === "out" ? "Out" : "Available"}
                    </span>
                  </div>
                </div>
                {imageUrl && (
                  <div className="menu-card-image">
                    <img
                      src={imageUrl}
                      alt={item.image.alt}
                      width={item.image.width}
                      height={item.image.height}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                )}
                <div className="menu-card-content">
                  <h3>{item.name}</h3>
                  <p>{item.description}</p>
                  {item.allergens.length > 0 && (
                    <div className="menu-allergens">
                      <span className="menu-allergens-label">Contains</span>
                      <ul aria-label={`Allergens in ${item.name}`}>
                        {ALLERGEN_OPTIONS.filter(({ value }) =>
                          item.allergens.includes(value),
                        ).map(({ value, label }) => (
                          <li key={value}>{label}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="menu-card-order">
                  <p className="menu-price">
                    {priceFormatter.format(Number(item.price))}
                  </p>
                  <div className="menu-add-control">
                    <button
                      type="button"
                      className="menu-add-button"
                      onClick={() => addDishToCart(item)}
                      disabled={
                        isOrderingBlocked ||
                        isSoldOut ||
                        cartQuantity >= MAX_ORDER_QUANTITY
                      }
                      aria-label={
                        isOrderingStatusUnavailable
                          ? `Online ordering status is ${
                              isOrderingStatusError
                                ? "unavailable"
                                : "being checked"
                            }. ${item.name} cannot be added`
                          : isOrderingPaused
                          ? `Online ordering is paused. ${item.name} cannot be added`
                          : isSoldOut
                          ? `${item.name} is sold out`
                          : cartQuantity >= MAX_ORDER_QUANTITY
                            ? `Maximum quantity added for ${item.name}`
                            : `Add ${item.name} to order`
                      }
                    >
                      {isOrderingStatusUnavailable
                        ? isOrderingStatusError
                          ? "Ordering unavailable"
                          : "Checking ordering"
                        : isOrderingPaused
                        ? "Ordering paused"
                        : isSoldOut
                        ? "Sold out"
                        : cartQuantity >= MAX_ORDER_QUANTITY
                          ? "Maximum added"
                          : cartQuantity > 0
                            ? "Add another"
                            : "Add to order"}
                    </button>
                    {cartQuantity > 0 && (
                      <span className="menu-order-quantity" aria-live="polite">
                        {cartQuantity} in order
                      </span>
                    )}
                  </div>
                </div>
              </article>
              );
            })}
          </div>

          <p className="menu-footnote">
            Allergen labels identify selected known allergens but do not
            guarantee against cross-contact. Please tell us about allergies
            when booking. A 20% service charge is added to each check.
          </p>
        </section>

        <section className="story-section" id="story" aria-labelledby="story-title">
          <div className="story-panel story-panel-dark">
            <p className="story-number">一</p>
            <div>
              <p className="eyebrow">The Snowfox way</p>
              <h2 id="story-title">A slower kind of evening.</h2>
              <p>
                Snowfox was imagined as a pause from the city: an intimate room,
                an open counter, and food that rewards attention. Our chefs
                work directly with trusted fishers and growers to compose each
                service in the moment.
              </p>
              <a href="#visit" className="story-link">
                Come sit at the counter <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>

          <div className="story-panel story-panel-light">
            <p className="quote-mark" aria-hidden="true">
              “
            </p>
            <blockquote>
              Good sushi is a conversation between patience, temperature, and
              touch.
            </blockquote>
            <div className="chef-signature">
              <span className="signature-line" aria-hidden="true" />
              <p>
                <strong>Ren Akiyama</strong>
                <small>Executive chef</small>
              </p>
            </div>
          </div>
        </section>

        <section className="visit-section" id="visit" aria-labelledby="visit-title">
          <div className="visit-intro">
            <p className="eyebrow">Join us</p>
            <h2 id="visit-title">Visit us on NW Kings.</h2>
            <p>
              Stop by for seasonal sushi and considered Japanese cooking in the
              heart of Corvallis.
            </p>
          </div>

          <div className="visit-details" id="contact-details">
            <div>
              <span>Location</span>
              <a
                className="visit-location-link"
                href="https://www.google.com/maps/search/?api=1&query=777%20NW%20Kings%20Blvd%2C%20Corvallis%2C%20OR"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open 777 NW Kings Boulevard, Corvallis, Oregon in Google Maps"
              >
                777 NW Kings Blvd
                <br />
                Corvallis, OR
              </a>
            </div>
            <div>
              <span>Hours</span>
              <p>Tuesday–Sunday<br />5:00–10:00 pm</p>
            </div>
            <iframe
              className="visit-map"
              title="Map showing 777 NW Kings Boulevard, Corvallis, Oregon"
              src="https://www.google.com/maps?q=777%20NW%20Kings%20Blvd%2C%20Corvallis%2C%20OR&output=embed"
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <a className="brand footer-brand" href="#top" aria-label="Back to top">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-copy">
            <strong>SNOWFOX</strong>
            <small>Japanese kitchen</small>
          </span>
        </a>
        <p>Seasonal Japanese dining, made with intention.</p>
        <div className="footer-links">
          <a href="#menu">Menu</a>
          <a href="#story">Story</a>
          <a href="#visit">Visit</a>
        </div>
        <p className="copyright">
          © {new Date().getFullYear()} Snowfox · sithulin78825
        </p>
      </footer>

      <button
        type="button"
        className="chat-launcher"
        onClick={openChat}
        disabled={authStatus === "restoring"}
        aria-haspopup="dialog"
        aria-label={isAuthenticated ? "Open Snowfox chat" : "Sign in to chat"}
      >
        <span className="chat-launcher-icon" aria-hidden="true">
          <MobileNavIcon name="chat" />
        </span>
        <span className="chat-launcher-copy">
          <strong>Ask Snowfox</strong>
          <small>{isAuthenticated ? "Menu chat" : "Sign in to chat"}</small>
        </span>
      </button>

      <nav
        className={`mobile-tab-bar ${
          canEditMenu ? "" : "mobile-tab-bar-five"
        }`.trim()}
        aria-label="Phone navigation"
      >
        <a href="#top">
          <MobileNavIcon name="home" />
          <span>Home</span>
        </a>
        <a href="#menu">
          <MobileNavIcon name="menu" />
          <span>Menu</span>
        </a>
        <a href="#visit">
          <MobileNavIcon name="visit" />
          <span>Visit</span>
        </a>
        {canEditMenu ? (
          <button
            type="button"
            onClick={openAdminWorkspace}
            aria-haspopup="dialog"
          >
            <MobileNavIcon name="admin" />
            <span>Manage</span>
          </button>
        ) : isAuthenticated ? (
          <>
            <button
              type="button"
              onClick={openCustomerOrders}
              disabled={isLoadingCustomerOrders}
            >
              <MobileNavIcon name="orders" />
              <span>{isLoadingCustomerOrders ? "Wait" : "My orders"}</span>
            </button>
            <button type="button" onClick={handleSignOut}>
              <MobileNavIcon name="signout" />
              <span>Sign out</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={openCustomerSignIn}
              disabled={authStatus === "restoring"}
            >
              <MobileNavIcon name="account" />
              <span>{authStatus === "restoring" ? "Wait" : "Sign in"}</span>
            </button>
            <button
              type="button"
              onClick={openAdminLogin}
              disabled={authStatus === "restoring"}
            >
              <MobileNavIcon name="admin" />
              <span>Admin</span>
            </button>
          </>
        )}
      </nav>

      <Modal
        isOpen={isAdminWorkspaceOpen}
        onClose={closeAdminWorkspace}
        titleId="admin-workspace-title"
        className="admin-workspace-modal"
      >
        <section className="modal-panel admin-workspace-panel">
          <button
            type="button"
            className="modal-close"
            aria-label="Close admin workspace"
            onClick={closeAdminWorkspace}
          >
            ×
          </button>

          <div className="modal-kicker">
            <span className="brand-mark" aria-hidden="true" />
            Restaurant administration
          </div>
          <h2 id="admin-workspace-title">Admin workspace</h2>
          <p className="modal-intro">
            Choose the part of Snowfox you want to manage.
          </p>

          <div className="admin-workspace-account">
            <p>
              Signed in as <strong>{currentUserEmail}</strong>
            </p>
            <button
              type="button"
              className="text-button"
              onClick={handleSignOut}
            >
              Sign out
            </button>
          </div>

          <div className="admin-workspace-grid">
            <button
              type="button"
              className="admin-workspace-card"
              onClick={() => openAdminWorkspaceTool("orders")}
              disabled={isLoadingAdminOrders}
              aria-haspopup="dialog"
              data-autofocus
            >
              <span className="admin-workspace-card-icon" aria-hidden="true">
                <MobileNavIcon name="orders" />
              </span>
              <span className="admin-workspace-card-copy">
                <small>Operations</small>
                <strong>Pickup orders</strong>
                <span>Review orders and update pickup status.</span>
              </span>
              <span className="admin-workspace-card-arrow" aria-hidden="true">
                →
              </span>
            </button>

            <button
              type="button"
              className="admin-workspace-card"
              onClick={() => openAdminWorkspaceTool("menu")}
              disabled={isLoadingEditor}
              aria-haspopup="dialog"
            >
              <span className="admin-workspace-card-icon" aria-hidden="true">
                <MobileNavIcon name="edit" />
              </span>
              <span className="admin-workspace-card-copy">
                <small>Food and availability</small>
                <strong>Menu</strong>
                <span>Edit dishes, images, allergens, and availability.</span>
              </span>
              <span className="admin-workspace-card-arrow" aria-hidden="true">
                →
              </span>
            </button>

            <button
              type="button"
              className="admin-workspace-card"
              onClick={() => openAdminWorkspaceTool("announcements")}
              disabled={isLoadingAnnouncements}
              aria-haspopup="dialog"
            >
              <span className="admin-workspace-card-icon" aria-hidden="true">
                <MobileNavIcon name="announcements" />
              </span>
              <span className="admin-workspace-card-copy">
                <small>Restaurant updates</small>
                <strong>Announcements</strong>
                <span>Publish discounts, closures, events, and notices.</span>
              </span>
              <span className="admin-workspace-card-arrow" aria-hidden="true">
                →
              </span>
            </button>
          </div>
        </section>
      </Modal>

      <Modal
        isOpen={isOrderOpen}
        onClose={closeOrder}
        titleId="order-title"
        className="order-modal"
      >
        <section className="order-panel" aria-busy={isSubmittingOrder}>
          <header className="order-header">
            <div>
              <div className="modal-kicker">
                <span className="brand-mark" aria-hidden="true" />
                Pickup only
              </div>
              <h2 id="order-title">
                {orderView === "checkout"
                  ? "Pickup details"
                  : orderView === "confirmation"
                    ? orderConfirmation?.type === "preview"
                      ? "Order preview"
                      : "Order request sent"
                    : "Your order"}
              </h2>
            </div>
            <button
              type="button"
              className="modal-close order-close"
              aria-label="Close order"
              onClick={closeOrder}
              disabled={isSubmittingOrder}
            >
              &times;
            </button>
          </header>

          {orderError && (
            <p className="form-alert order-alert" role="alert">
              {orderError}
            </p>
          )}

          {isOrderingStatusUnavailable && orderView !== "confirmation" && (
            <div className="order-ordering-warning" role="alert">
              <strong>
                {isOrderingStatusError
                  ? "Online ordering is unavailable"
                  : "Checking online ordering"}
              </strong>
              <p>{orderingStatusUnavailableMessage}</p>
              {isOrderingStatusError && (
                <button
                  type="button"
                  className="order-status-retry"
                  onClick={() =>
                    refreshOrderingStatus().catch(() => {
                      // The warning remains in its retryable error state.
                    })
                  }
                >
                  Try again
                </button>
              )}
            </div>
          )}

          {!isOrderingStatusUnavailable &&
            isOrderingPaused &&
            orderView !== "confirmation" && (
            <div className="order-ordering-warning" role="alert">
              <strong>Online ordering is paused</strong>
              <p>{orderingPausedMessage}</p>
            </div>
            )}

          {orderView === "cart" && (
            <div className="order-cart">
              {cartLineItems.length === 0 ? (
                <div className="order-empty-state">
                  <p>Your order is empty.</p>
                  <p>Add dishes from the menu when you are ready.</p>
                </div>
              ) : (
                <ul className="order-cart-list" aria-label="Order items">
                  {cartLineItems.map(
                    ({ item, quantity, unitPriceCents, lineTotalCents }) => {
                      const isUnavailable = item.availability === "out";

                      return (
                        <li className="order-cart-item" key={item.id}>
                          <div className="order-item-copy">
                            <h3>{item.name}</h3>
                            <p>
                              {formatPriceCents(unitPriceCents)} each
                              <span aria-hidden="true"> · </span>
                              <strong>{formatPriceCents(lineTotalCents)}</strong>
                            </p>
                            {isUnavailable && (
                              <p className="order-item-unavailable" role="alert">
                                Sold out — remove this dish before checkout.
                              </p>
                            )}
                          </div>
                          <div className="order-item-actions">
                            <div
                              className="order-quantity-controls"
                              aria-label={`Quantity for ${item.name}`}
                            >
                              <button
                                type="button"
                                onClick={() => changeCartQuantity(item.id, -1)}
                                aria-label={`Decrease ${item.name} quantity`}
                              >
                                &minus;
                              </button>
                              <span aria-live="polite">{quantity}</span>
                              <button
                                type="button"
                                onClick={() => changeCartQuantity(item.id, 1)}
                                disabled={
                                  isOrderingBlocked ||
                                  isUnavailable ||
                                  quantity >= MAX_ORDER_QUANTITY
                                }
                                aria-label={`Increase ${item.name} quantity`}
                              >
                                +
                              </button>
                            </div>
                            <button
                              type="button"
                              className="order-remove-button"
                              onClick={() => removeCartItem(item.id)}
                              aria-label={`Remove ${item.name} from order`}
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      );
                    },
                  )}
                </ul>
              )}

              {ordersApiUrl && menuDataStatus !== "live" && (
                <p className="order-menu-warning" role="alert">
                  The live menu is unavailable, so this order cannot be sent.
                  Reload the page and try again.
                </p>
              )}

              {!ordersApiUrl && (
                <p className="order-preview-notice">
                  Order API preview mode: you can review the flow, but nothing
                  will be sent.
                </p>
              )}

              <div className="order-summary">
                <span>
                  {cartItemCount} {cartItemCount === 1 ? "item" : "items"}
                </span>
                <span>
                  Menu subtotal <strong>{formatPriceCents(cartSubtotalCents)}</strong>
                </span>
              </div>
              <p className="order-total-note">
                This display subtotal uses the current menu. The restaurant
                determines the final total. Pay at a Fred Meyer checkout
                register when you pick up your order.
              </p>

              <div className="order-actions">
                <button
                  type="button"
                  className="button button-primary order-checkout-button"
                  onClick={beginPickupCheckout}
                  disabled={
                    isOrderingBlocked ||
                    cartLineItems.length === 0 ||
                    cartHasUnavailableItems ||
                    Boolean(ordersApiUrl && menuDataStatus !== "live")
                  }
                  data-autofocus
                >
                  Continue to pickup details
                </button>
              </div>
            </div>
          )}

          {orderView === "checkout" && (
            <form
              className="order-checkout-form"
              onSubmit={handleOrderSubmit}
              noValidate
            >
              <div className="order-pickup-badge">
                <strong>Pickup at Snowfox</strong>
                <span>777 NW Kings Blvd, Corvallis, OR</span>
              </div>

              <label className="order-field" htmlFor="pickupName">
                <span>Pickup name</span>
                <input
                  id="pickupName"
                  name="name"
                  type="text"
                  autoComplete="name"
                  maxLength={MAX_CUSTOMER_NAME_LENGTH}
                  value={pickupValues.name}
                  onChange={handlePickupChange}
                  aria-invalid={Boolean(pickupErrors.name)}
                  aria-describedby={
                    pickupErrors.name ? "pickupName-error" : undefined
                  }
                  disabled={isSubmittingOrder || isOrderingBlocked}
                  data-autofocus
                />
              </label>
              {pickupErrors.name && (
                <p className="field-error" id="pickupName-error">
                  {pickupErrors.name}
                </p>
              )}

              <label className="order-field" htmlFor="pickupPhoneNumber">
                <span>Phone number</span>
                <input
                  id="pickupPhoneNumber"
                  name="phoneNumber"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+1 415 555 2671"
                  value={pickupValues.phoneNumber}
                  onChange={handlePickupChange}
                  aria-invalid={Boolean(pickupErrors.phoneNumber)}
                  aria-describedby={
                    pickupErrors.phoneNumber
                      ? "pickupPhoneNumber-error"
                      : "pickupPhoneNumber-help"
                  }
                  disabled={isSubmittingOrder || isOrderingBlocked}
                />
              </label>
              {pickupErrors.phoneNumber ? (
                <p className="field-error" id="pickupPhoneNumber-error">
                  {pickupErrors.phoneNumber}
                </p>
              ) : (
                <p className="field-help" id="pickupPhoneNumber-help">
                  Include the country code so the restaurant can reach you.
                </p>
              )}

              <label className="order-field" htmlFor="customerNote">
                <span>Pickup note (optional)</span>
                <textarea
                  id="customerNote"
                  name="note"
                  rows="4"
                  maxLength={MAX_CUSTOMER_NOTE_LENGTH}
                  value={pickupValues.note}
                  onChange={handlePickupChange}
                  aria-invalid={Boolean(pickupErrors.note)}
                  aria-describedby={
                    pickupErrors.note
                      ? "customerNote-error"
                      : "customerNote-count"
                  }
                  disabled={isSubmittingOrder || isOrderingBlocked}
                />
              </label>
              {pickupErrors.note ? (
                <p className="field-error" id="customerNote-error">
                  {pickupErrors.note}
                </p>
              ) : (
                <p className="order-note-count" id="customerNote-count">
                  {pickupValues.note.length}/{MAX_CUSTOMER_NOTE_LENGTH}
                </p>
              )}

              <div className="order-summary order-checkout-summary">
                <span>
                  {cartItemCount} {cartItemCount === 1 ? "item" : "items"}
                </span>
                <span>
                  Menu subtotal <strong>{formatPriceCents(cartSubtotalCents)}</strong>
                </span>
              </div>
              <p className="order-auth-note">
                {isAuthenticated
                  ? `Submitting as ${currentUserEmail}.`
                  : "You will sign in or create an account before submitting."}
              </p>
              <p className="order-payment-note">
                No online payment is collected. Pay at a Fred Meyer checkout
                register when you pick up your order. The restaurant will
                confirm availability and the final total.
              </p>

              <div className="order-actions order-checkout-actions">
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => {
                    setOrderError("");
                    setPickupErrors({});
                    setOrderView("cart");
                  }}
                  disabled={isSubmittingOrder}
                >
                  Back to order
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={
                    isSubmittingOrder ||
                    isOrderingBlocked ||
                    authStatus === "restoring"
                  }
                >
                  {isSubmittingOrder
                    ? "Sending…"
                    : isAuthenticated
                      ? ordersApiUrl
                        ? "Submit pickup order"
                        : "Create order preview"
                      : "Continue to sign in"}
                </button>
              </div>
            </form>
          )}

          {orderView === "confirmation" && orderConfirmation && (
            <div className="order-confirmation">
              {orderConfirmation.type === "preview" ? (
                <>
                  <p className="order-preview-confirmation" role="status">
                    <strong>Preview only — nothing was sent</strong>
                  </p>
                  <p>
                    This preview shows what the pickup-order flow will look
                    like after an orders API is configured.
                  </p>
                </>
              ) : (
                <>
                  <p className="order-submitted-message" role="status">
                    Your pickup request was sent to the restaurant.
                  </p>
                  <p>
                    No payment was collected online. Pay at a Fred Meyer
                    checkout register when you pick up your order. The
                    restaurant will confirm availability and the final total.
                  </p>
                </>
              )}

              <dl className="order-confirmation-details">
                <div>
                  <dt>
                    {orderConfirmation.type === "preview"
                      ? "Preview ID"
                      : "Request ID"}
                  </dt>
                  <dd>{orderConfirmation.reference}</dd>
                </div>
                <div>
                  <dt>Pickup name</dt>
                  <dd>{orderConfirmation.pickupContact.name}</dd>
                </div>
                <div>
                  <dt>Items</dt>
                  <dd>{orderConfirmation.itemCount}</dd>
                </div>
                <div>
                  <dt>Displayed subtotal</dt>
                  <dd>{formatPriceCents(orderConfirmation.subtotalCents)}</dd>
                </div>
              </dl>

              <div className="order-actions">
                {orderConfirmation.type === "preview" && (
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => {
                      setOrderConfirmation(null);
                      setOrderView("cart");
                    }}
                  >
                    Back to order
                  </button>
                )}
                <button
                  type="button"
                  className="button button-primary"
                  onClick={closeOrder}
                  data-autofocus
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </section>
      </Modal>

      <Modal
        isOpen={isCustomerOrdersOpen}
        onClose={closeCustomerOrders}
        titleId="customer-orders-title"
        className="admin-orders-modal customer-orders-modal"
      >
        <section
          className="admin-orders-panel customer-orders-panel"
          aria-busy={isLoadingCustomerOrders}
        >
          <header className="admin-orders-header customer-orders-header">
            <div>
              <div className="modal-kicker">
                <span className="brand-mark" aria-hidden="true" />
                Customer account
              </div>
              <h2 id="customer-orders-title">My orders</h2>
              <p>Your newest pickup orders appear first.</p>
            </div>
            <button
              type="button"
              className="modal-close admin-orders-close"
              aria-label="Close my orders"
              onClick={closeCustomerOrders}
            >
              &times;
            </button>
          </header>

          <div className="admin-orders-toolbar customer-orders-toolbar">
            <p aria-live="polite">
              {customerOrders.length === 1
                ? "Showing 1 order"
                : `Showing ${customerOrders.length} orders`}
            </p>
            <div>
              <button
                type="button"
                className="button button-small button-quiet"
                onClick={() => loadCustomerOrders()}
                disabled={isLoadingCustomerOrders}
                data-autofocus
              >
                {isLoadingCustomerOrders ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          {customerOrdersError && (
            <div className="admin-orders-error" role="alert">
              <p>{customerOrdersError}</p>
              <button
                type="button"
                className="button button-small button-quiet"
                onClick={() => loadCustomerOrders()}
                disabled={isLoadingCustomerOrders}
              >
                Try again
              </button>
            </div>
          )}

          {isLoadingCustomerOrders && customerOrders.length === 0 ? (
            <div className="admin-orders-state" role="status">
              <span className="admin-orders-spinner" aria-hidden="true" />
              <p>Loading your orders…</p>
            </div>
          ) : customerOrders.length === 0 && !customerOrdersError ? (
            <div className="admin-orders-state">
              <p>No pickup orders yet.</p>
              <span>
                Orders you submit while signed in will appear here.
              </span>
            </div>
          ) : (
            <div className="admin-orders-list customer-orders-list">
              {customerOrders.map((order) => {
                const orderItems = Array.isArray(order.items)
                  ? order.items
                  : [];
                const orderStatus =
                  typeof order.status === "string" && order.status.trim()
                    ? order.status.trim().toUpperCase()
                    : "UNKNOWN";
                const contact =
                  order.pickupContact &&
                  typeof order.pickupContact === "object" &&
                  !Array.isArray(order.pickupContact)
                    ? order.pickupContact
                    : {};
                const itemCountValue = Number(order.itemCount);
                const itemCount = Number.isSafeInteger(itemCountValue)
                  ? itemCountValue
                  : orderItems.reduce((total, item) => {
                      const quantity = Number(item?.quantity);
                      return Number.isSafeInteger(quantity)
                        ? total + quantity
                        : total;
                    }, 0);
                const totalCents = Number(order.totalCents);
                const totalLabel = Number.isSafeInteger(totalCents)
                  ? formatPriceCents(totalCents)
                  : "Unavailable";
                const customerNote =
                  typeof order.customerNote === "string"
                    ? order.customerNote.trim()
                    : "";
                const restaurantNote =
                  typeof order.restaurantNote === "string"
                    ? order.restaurantNote.trim()
                    : "";
                const pickupTimeCandidate =
                  orderStatus === "CONFIRMED"
                    ? order.pickupTime
                    : orderStatus === "FAILED_TO_PICKUP"
                      ? order.scheduledPickupTime
                      : "";
                const pickupTime = isCanonicalIsoTimestamp(
                  pickupTimeCandidate,
                )
                  ? pickupTimeCandidate
                  : "";
                const failedToPickupAt =
                  orderStatus === "FAILED_TO_PICKUP" &&
                  isCanonicalIsoTimestamp(order.failedToPickupAt)
                    ? order.failedToPickupAt
                    : "";
                const fulfillment =
                  typeof order.fulfillment === "string" &&
                  order.fulfillment.trim()
                    ? order.fulfillment.trim().toLowerCase()
                    : "pickup";

                return (
                  <details
                    className="admin-order-card customer-order-card"
                    key={order.orderId}
                  >
                    <summary className="admin-order-card-header">
                      <div>
                        <p className="admin-order-id-label">Order</p>
                        <h3>{order.orderId}</h3>
                        <time dateTime={order.createdAt || undefined}>
                          {formatOrderDate(order.createdAt)}
                        </time>
                        <p className="admin-order-summary-context">
                          <span>
                            {itemCount} {itemCount === 1 ? "item" : "items"}
                          </span>
                          <span aria-hidden="true">•</span>
                          <span className="customer-order-fulfillment-label">
                            {fulfillment}
                          </span>
                          {pickupTime && (
                            <>
                              <span aria-hidden="true">•</span>
                              <span>{formatPickupTime(pickupTime)}</span>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="admin-order-summary-meta">
                        <div className="admin-order-badges">
                          <span
                            className="admin-order-badge"
                            data-status={orderStatus}
                          >
                            {formatStatusLabel(orderStatus)}
                          </span>
                        </div>
                        <div className="admin-order-summary-actions">
                          <span className="admin-order-summary-total">
                            <span>Total</span>
                            <strong>{totalLabel}</strong>
                          </span>
                          <span className="admin-order-expand-label">
                            <span className="admin-order-expand-closed">
                              View order
                            </span>
                            <span className="admin-order-expand-open">
                              Hide order
                            </span>
                            <svg
                              viewBox="0 0 24 24"
                              width="16"
                              height="16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="m6 9 6 6 6-6" />
                            </svg>
                          </span>
                        </div>
                      </div>
                    </summary>

                    <dl className="admin-order-contact customer-order-pickup">
                      <div>
                        <dt>Pickup name</dt>
                        <dd>
                          {typeof contact.name === "string" && contact.name
                            ? contact.name
                            : "Not provided"}
                        </dd>
                      </div>
                      <div>
                        <dt>Phone</dt>
                        <dd>
                          {typeof contact.phoneNumber === "string" &&
                          contact.phoneNumber
                            ? contact.phoneNumber
                            : "Not provided"}
                        </dd>
                      </div>
                      <div>
                        <dt>Fulfillment</dt>
                        <dd className="customer-order-fulfillment">
                          {fulfillment}
                        </dd>
                      </div>
                      {pickupTime && (
                        <div>
                          <dt>
                            {orderStatus === "FAILED_TO_PICKUP"
                              ? "Scheduled pickup"
                              : "Pickup time"}
                          </dt>
                          <dd>
                            <time dateTime={pickupTime}>
                              {formatPickupTime(pickupTime)}
                            </time>
                          </dd>
                        </div>
                      )}
                      {failedToPickupAt && (
                        <div>
                          <dt>Marked not picked up</dt>
                          <dd>
                            <time dateTime={failedToPickupAt}>
                              {formatOrderDate(failedToPickupAt)}
                            </time>
                          </dd>
                        </div>
                      )}
                    </dl>

                    <div className="admin-order-items">
                      <h4>Ordered items</h4>
                      {orderItems.length > 0 ? (
                        <ul>
                          {orderItems.map((item, itemIndex) => {
                            const itemName =
                              typeof item?.name === "string" && item.name
                                ? item.name
                                : "Menu item";
                            const itemCategory =
                              typeof item?.category === "string"
                                ? item.category
                                : "";
                            const itemQuantity = Number(item?.quantity);
                            const unitPriceCents = Number(
                              item?.unitPriceCents,
                            );
                            const lineTotalCents = Number(
                              item?.lineTotalCents,
                            );

                            return (
                              <li
                                key={`${order.orderId}-${
                                  typeof item?.dishId === "string"
                                    ? item.dishId
                                    : itemIndex
                                }`}
                              >
                                <div>
                                  <strong>
                                    {Number.isSafeInteger(itemQuantity)
                                      ? itemQuantity
                                      : "?"}{" "}
                                    × {itemName}
                                  </strong>
                                  <span>
                                    {itemCategory || "Menu item"}
                                    {Number.isSafeInteger(unitPriceCents)
                                      ? ` · ${formatPriceCents(
                                          unitPriceCents,
                                        )} each`
                                      : ""}
                                  </span>
                                </div>
                                <span>
                                  {Number.isSafeInteger(lineTotalCents)
                                    ? formatPriceCents(lineTotalCents)
                                    : "Unavailable"}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="admin-order-missing-items">
                          Item details are unavailable.
                        </p>
                      )}
                    </div>

                    {customerNote && (
                      <div className="admin-order-note">
                        <h4>Pickup note</h4>
                        <p>{customerNote}</p>
                      </div>
                    )}

                    {restaurantNote && (
                      <div className="admin-order-note admin-order-note-restaurant">
                        <h4>Restaurant note</h4>
                        <p>{restaurantNote}</p>
                      </div>
                    )}

                    <footer className="admin-order-card-footer">
                      <span>
                        {itemCount} {itemCount === 1 ? "item" : "items"}
                      </span>
                      <div>
                        <span>Total</span>
                        <strong>{totalLabel}</strong>
                      </div>
                    </footer>
                  </details>
                );
              })}
            </div>
          )}

          {customerOrdersNextToken && (
            <div className="admin-orders-pagination">
              <button
                type="button"
                className="button button-quiet"
                onClick={() =>
                  loadCustomerOrders({
                    append: true,
                    nextToken: customerOrdersNextToken,
                  })
                }
                disabled={isLoadingCustomerOrders}
              >
                {isLoadingCustomerOrders ? "Loading…" : "Load more orders"}
              </button>
            </div>
          )}
        </section>
      </Modal>

      <Modal
        isOpen={isAdminOrdersOpen}
        onClose={closeAdminOrders}
        titleId="admin-orders-title"
        className="admin-orders-modal"
      >
        <section
          className="admin-orders-panel"
          aria-busy={isLoadingAdminOrders}
        >
          <header className="admin-orders-header">
            <div>
              <div className="modal-kicker">
                <span className="brand-mark" aria-hidden="true" />
                Admin workspace
              </div>
              <h2 id="admin-orders-title">Pickup orders</h2>
              <p>Newest orders appear first.</p>
            </div>
            <button
              type="button"
              className="modal-close admin-orders-close"
              aria-label="Close orders"
              onClick={closeAdminOrders}
            >
              ×
            </button>
          </header>

          <div className="admin-orders-toolbar">
            <p aria-live="polite">
              {adminOrders.length === 1
                ? "Showing 1 order"
                : `Showing ${adminOrders.length} orders`}
            </p>
            <div>
              <button
                type="button"
                className="button button-small button-quiet"
                onClick={refreshAdminOrdersWorkspace}
                disabled={isLoadingAdminOrders}
                data-autofocus
              >
                {isLoadingAdminOrders ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          <section
            className={`admin-ordering-control${
              !isOrderingStatusUnavailable && isOrderingPaused
                ? " admin-ordering-control-paused"
                : ""
            }`}
            aria-labelledby="admin-ordering-control-title"
          >
            <header>
              <div>
                <p className="admin-ordering-control-kicker">
                  Customer ordering
                </p>
                <h3 id="admin-ordering-control-title">
                  {isOrderingStatusError
                    ? "Ordering status is unavailable"
                    : isOrderingStatusLoading
                      ? "Checking online ordering"
                      : isOrderingPaused
                        ? "Online ordering is paused"
                        : "Online ordering is open"}
                </h3>
              </div>
              <span
                className={`admin-ordering-status-badge admin-ordering-status-badge-${
                  isOrderingStatusError
                    ? "error"
                    : isOrderingStatusLoading
                      ? "checking"
                      : isOrderingPaused
                        ? "paused"
                        : "open"
                }`}
              >
                {isOrderingStatusError
                  ? "Unavailable"
                  : isOrderingStatusLoading
                    ? "Checking"
                    : isOrderingPaused
                      ? "Paused"
                      : "Accepting orders"}
              </span>
            </header>

            <label
              className="admin-ordering-message-field"
              htmlFor="admin-ordering-pause-message"
            >
              <span>
                {isOrderingPaused && !isOrderingStatusUnavailable
                  ? "Current customer message"
                  : "Message customers will see while ordering is paused"}
              </span>
              <textarea
                id="admin-ordering-pause-message"
                rows="3"
                maxLength={MAX_ORDERING_STATUS_MESSAGE_LENGTH}
                value={adminOrderingPauseMessage}
                onChange={(event) =>
                  setAdminOrderingPauseMessage(event.target.value)
                }
                disabled={
                  isUpdatingAdminOrderingStatus ||
                  isOrderingStatusUnavailable
                }
                required
              />
              <small>
                {adminOrderingPauseMessage.length}/
                {MAX_ORDERING_STATUS_MESSAGE_LENGTH}
              </small>
            </label>

            <div className="admin-ordering-control-actions">
              {!adminOrderingStatusApiUrl && (
                <span>Ordering status API is not configured.</span>
              )}
              {adminOrderingStatusApiUrl && isOrderingStatusError && (
                <>
                  <span>Current ordering status could not be checked.</span>
                  <button
                    type="button"
                    className="button button-small button-quiet"
                    onClick={() =>
                      refreshOrderingStatus().catch(() => {
                        // Keep the control unavailable until a retry succeeds.
                      })
                    }
                  >
                    Try status check again
                  </button>
                </>
              )}
              {isOrderingPaused && !isOrderingStatusError && (
                <button
                  type="button"
                  className="button button-small button-quiet"
                  onClick={() => updateAdminOrderingStatus(false)}
                  disabled={
                    isUpdatingAdminOrderingStatus ||
                    isOrderingStatusUnavailable ||
                    !adminOrderingStatusApiUrl
                  }
                >
                  {adminOrderingStatusAction === "save"
                    ? "Saving..."
                    : "Save paused message"}
                </button>
              )}
              {!isOrderingStatusError && (
                <button
                  type="button"
                  className={`button button-small ${
                    isOrderingPaused ? "button-primary" : "button-danger"
                  }`}
                  onClick={() =>
                    updateAdminOrderingStatus(isOrderingPaused)
                  }
                  disabled={
                    isUpdatingAdminOrderingStatus ||
                    isOrderingStatusUnavailable ||
                    !adminOrderingStatusApiUrl
                  }
                >
                  {adminOrderingStatusAction === "resume"
                    ? "Resuming..."
                    : adminOrderingStatusAction === "pause"
                      ? "Pausing..."
                      : isOrderingPaused
                        ? "Resume online ordering"
                        : "Pause online ordering"}
                </button>
              )}
            </div>
          </section>

          {adminOrdersError && (
            <div className="admin-orders-error" role="alert">
              <p>{adminOrdersError}</p>
              <button
                type="button"
                className="button button-small button-quiet"
                onClick={refreshAdminOrdersWorkspace}
                disabled={isLoadingAdminOrders}
              >
                Try again
              </button>
            </div>
          )}

          {adminOrderStatusNotice && (
            <div
              ref={adminOrderStatusNoticeRef}
              className={`admin-order-status-notice admin-order-status-notice-${adminOrderStatusNotice.type}`}
              tabIndex={-1}
              role={
                adminOrderStatusNotice.type === "error" ? "alert" : "status"
              }
              aria-live={
                adminOrderStatusNotice.type === "error"
                  ? "assertive"
                  : "polite"
              }
            >
              <p>{adminOrderStatusNotice.message}</p>
              <button
                type="button"
                aria-label="Dismiss order status notice"
                onClick={() => setAdminOrderStatusNotice(null)}
              >
                &times;
              </button>
            </div>
          )}

          {isLoadingAdminOrders && adminOrders.length === 0 ? (
            <div className="admin-orders-state" role="status">
              <span className="admin-orders-spinner" aria-hidden="true" />
              <p>Loading restaurant orders…</p>
            </div>
          ) : adminOrders.length === 0 && !adminOrdersError ? (
            <div className="admin-orders-state">
              <p>No pickup orders yet.</p>
              <span>New orders will appear here after customers submit them.</span>
            </div>
          ) : (
            <div className="admin-orders-list">
              {adminOrders.map((order) => {
                const orderItems = Array.isArray(order.items)
                  ? order.items
                  : [];
                const orderStatus =
                  normalizeOrderStatus(order.status);
                const notificationStatus =
                  normalizeOrderStatus(order.notificationStatus);
                const contact =
                  order.pickupContact &&
                  typeof order.pickupContact === "object"
                    ? order.pickupContact
                    : {};
                const allowedStatusTransitions =
                  ORDER_STATUS_TRANSITIONS[orderStatus] || [];
                const isKnownTerminalStatus =
                  Object.hasOwn(ORDER_STATUS_TRANSITIONS, orderStatus) &&
                  allowedStatusTransitions.length === 0;
                const selectedStatus =
                  adminOrderStatusSelections[order.orderId] || "";
                const selectedStatusDetails =
                  adminOrderStatusDetails[order.orderId] || {};
                const selectedStatusErrors =
                  adminOrderStatusErrors[order.orderId] || {};
                const isUpdatingStatus = Boolean(
                  adminOrderStatusUpdating[order.orderId],
                );
                const confirmedPickupTime =
                  orderStatus === "CONFIRMED" &&
                  isCanonicalIsoTimestamp(order.pickupTime)
                    ? order.pickupTime
                    : "";
                const pickupTimeCandidate =
                  confirmedPickupTime ||
                  (orderStatus === "FAILED_TO_PICKUP"
                    ? order.scheduledPickupTime
                    : "");
                const pickupTime = isCanonicalIsoTimestamp(
                  pickupTimeCandidate,
                )
                  ? pickupTimeCandidate
                  : "";
                const failedToPickupAt =
                  orderStatus === "FAILED_TO_PICKUP" &&
                  isCanonicalIsoTimestamp(order.failedToPickupAt)
                    ? order.failedToPickupAt
                    : "";
                const restaurantNote =
                  typeof order.restaurantNote === "string"
                    ? order.restaurantNote.trim()
                    : "";
                const canMarkFailedToPickup =
                  Boolean(confirmedPickupTime) &&
                  new Date(confirmedPickupTime).getTime() <= adminOrderClock;
                const pickupFailureHistory =
                  adminPickupFailureHistories[order.orderId] || null;
                const pickupFailureHistoryId = `pickup-failure-history-${order.orderId}`;

                return (
                  <details className="admin-order-card" key={order.orderId}>
                    <summary className="admin-order-card-header">
                      <div>
                        <p className="admin-order-id-label">Order</p>
                        <h3>{order.orderId}</h3>
                        <time dateTime={order.createdAt}>
                          {formatOrderDate(order.createdAt)}
                        </time>
                        <p className="admin-order-summary-context">
                          <span>{contact.name || "Pickup customer"}</span>
                          <span aria-hidden="true">•</span>
                          <span>
                            {order.itemCount}{" "}
                            {Number(order.itemCount) === 1 ? "item" : "items"}
                          </span>
                          {pickupTime && (
                            <>
                              <span aria-hidden="true">•</span>
                              <span>{formatPickupTime(pickupTime)}</span>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="admin-order-summary-meta">
                        <div className="admin-order-badges">
                          <span
                            className="admin-order-badge"
                            data-status={orderStatus}
                          >
                            Order {formatStatusLabel(orderStatus)}
                          </span>
                          <span
                            className="admin-order-badge admin-order-badge-muted"
                            data-status={notificationStatus}
                          >
                            Email {formatStatusLabel(notificationStatus)}
                          </span>
                        </div>
                        <div className="admin-order-summary-actions">
                          <span className="admin-order-summary-total">
                            <span>Total</span>
                            <strong>
                              {formatPriceCents(order.totalCents)}
                            </strong>
                          </span>
                          <span className="admin-order-expand-label">
                            <span className="admin-order-expand-closed">
                              View order
                            </span>
                            <span className="admin-order-expand-open">
                              Hide order
                            </span>
                            <svg
                              viewBox="0 0 24 24"
                              width="16"
                              height="16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="m6 9 6 6 6-6" />
                            </svg>
                          </span>
                        </div>
                      </div>
                    </summary>

                    <dl className="admin-order-contact">
                      <div>
                        <dt>Pickup name</dt>
                        <dd>{contact.name || "Not provided"}</dd>
                      </div>
                      <div>
                        <dt>Phone</dt>
                        <dd>
                          {contact.phoneNumber ? (
                            <a href={`tel:${contact.phoneNumber}`}>
                              {contact.phoneNumber}
                            </a>
                          ) : (
                            "Not provided"
                          )}
                        </dd>
                      </div>
                      {order.customerEmail && (
                        <div>
                          <dt>Email</dt>
                          <dd>
                            <a href={`mailto:${order.customerEmail}`}>
                              {order.customerEmail}
                            </a>
                          </dd>
                        </div>
                      )}
                      {pickupTime && (
                        <div>
                          <dt>
                            {orderStatus === "FAILED_TO_PICKUP"
                              ? "Scheduled pickup"
                              : "Pickup time"}
                          </dt>
                          <dd>
                            <time dateTime={pickupTime}>
                              {formatPickupTime(pickupTime)}
                            </time>
                          </dd>
                        </div>
                      )}
                      {failedToPickupAt && (
                        <div>
                          <dt>Marked not picked up</dt>
                          <dd>
                            <time dateTime={failedToPickupAt}>
                              {formatOrderDate(failedToPickupAt)}
                            </time>
                          </dd>
                        </div>
                      )}
                    </dl>

                    <div className="admin-order-items">
                      <h4>Pickup items</h4>
                      {orderItems.length > 0 ? (
                        <ul>
                          {orderItems.map((item, itemIndex) => (
                            <li
                              key={`${order.orderId}-${item.dishId || itemIndex}`}
                            >
                              <div>
                                <strong>
                                  {item.quantity} × {item.name}
                                </strong>
                                {item.category && <span>{item.category}</span>}
                              </div>
                              <span>
                                {formatPriceCents(item.lineTotalCents)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="admin-order-missing-items">
                          Item details are unavailable.
                        </p>
                      )}
                    </div>

                    {order.customerNote && (
                      <div className="admin-order-note">
                        <h4>Customer note</h4>
                        <p>{order.customerNote}</p>
                      </div>
                    )}

                    {restaurantNote && (
                      <div className="admin-order-note admin-order-note-restaurant">
                        <h4>Restaurant note to customer</h4>
                        <p>{restaurantNote}</p>
                      </div>
                    )}

                    <section
                      className={`admin-order-status-control ${
                        allowedStatusTransitions.length === 0
                          ? "admin-order-status-control-terminal"
                          : ""
                      }`}
                      aria-busy={isUpdatingStatus}
                    >
                      <div className="admin-order-status-heading">
                        <div>
                          <h4>Order status</h4>
                          <p>
                            Current:{" "}
                            <strong>{formatStatusLabel(orderStatus)}</strong>
                          </p>
                        </div>
                        {isUpdatingStatus && (
                          <span role="status">Updating…</span>
                        )}
                      </div>

                      {allowedStatusTransitions.length > 0 ? (
                        <>
                          <form
                            className="admin-order-status-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              updateAdminOrderStatus(order.orderId);
                            }}
                            noValidate
                          >
                            <div className="admin-order-status-field">
                              <label
                                htmlFor={`next-status-${order.orderId}`}
                              >
                                Next status
                              </label>
                              <select
                                id={`next-status-${order.orderId}`}
                                value={selectedStatus}
                                onChange={(event) =>
                                  selectAdminOrderStatus(
                                    order.orderId,
                                    event.target.value,
                                  )
                                }
                                disabled={isUpdatingStatus}
                              >
                                <option value="">Choose next status</option>
                                {allowedStatusTransitions.map((status) => (
                                  <option key={status} value={status}>
                                    {formatStatusLabel(status)}
                                  </option>
                                ))}
                              </select>
                            </div>

                            {selectedStatus === "CONFIRMED" && (
                              <div className="admin-order-status-field">
                                <label
                                  htmlFor={`pickup-time-${order.orderId}`}
                                >
                                  Pickup date and time
                                </label>
                                <input
                                  id={`pickup-time-${order.orderId}`}
                                  type="datetime-local"
                                  value={
                                    selectedStatusDetails.pickupTimeLocal ||
                                    ""
                                  }
                                  min={toLocalDateTimeInputValue()}
                                  step="60"
                                  onChange={(event) =>
                                    changeAdminOrderStatusDetail(
                                      order.orderId,
                                      "pickupTimeLocal",
                                      event.target.value,
                                    )
                                  }
                                  disabled={isUpdatingStatus}
                                  aria-invalid={Boolean(
                                    selectedStatusErrors.pickupTimeLocal,
                                  )}
                                  aria-describedby={
                                    selectedStatusErrors.pickupTimeLocal
                                      ? `pickup-time-error-${order.orderId}`
                                      : `pickup-time-help-${order.orderId}`
                                  }
                                />
                                <span
                                  id={`pickup-time-help-${order.orderId}`}
                                  className="admin-order-status-help"
                                >
                                  Entered in this device&apos;s local time.
                                </span>
                                {selectedStatusErrors.pickupTimeLocal && (
                                  <span
                                    id={`pickup-time-error-${order.orderId}`}
                                    className="admin-order-status-field-error"
                                    role="alert"
                                  >
                                    {
                                      selectedStatusErrors.pickupTimeLocal
                                    }
                                  </span>
                                )}
                              </div>
                            )}

                            {selectedStatus && (
                              <div className="admin-order-status-field admin-order-status-field-wide">
                                <label
                                  className="admin-order-status-note-label"
                                  htmlFor={`restaurant-note-${order.orderId}`}
                                >
                                  <span>
                                    Message to customer <em>(optional)</em>
                                  </span>
                                  <span>
                                    {
                                      (
                                        selectedStatusDetails.restaurantNote ||
                                        ""
                                      ).length
                                    }
                                    /{MAX_RESTAURANT_NOTE_LENGTH}
                                  </span>
                                </label>
                                <textarea
                                  id={`restaurant-note-${order.orderId}`}
                                  rows="3"
                                  maxLength={MAX_RESTAURANT_NOTE_LENGTH}
                                  value={
                                    selectedStatusDetails.restaurantNote ||
                                    ""
                                  }
                                  onChange={(event) =>
                                    changeAdminOrderStatusDetail(
                                      order.orderId,
                                      "restaurantNote",
                                      event.target.value,
                                    )
                                  }
                                  disabled={isUpdatingStatus}
                                  placeholder={
                                    selectedStatus === "CONFIRMED"
                                      ? "For example: Please arrive at the pickup counter five minutes early."
                                      : "Add an explanation or next step for the customer."
                                  }
                                  aria-invalid={Boolean(
                                    selectedStatusErrors.restaurantNote,
                                  )}
                                  aria-describedby={
                                    selectedStatusErrors.restaurantNote
                                      ? `restaurant-note-error-${order.orderId}`
                                      : undefined
                                  }
                                />
                                {selectedStatusErrors.restaurantNote && (
                                  <span
                                    id={`restaurant-note-error-${order.orderId}`}
                                    className="admin-order-status-field-error"
                                    role="alert"
                                  >
                                    {
                                      selectedStatusErrors.restaurantNote
                                    }
                                  </span>
                                )}
                              </div>
                            )}
                            <button
                              type="submit"
                              className="button button-small button-dark admin-order-status-submit"
                              disabled={!selectedStatus || isUpdatingStatus}
                            >
                              {isUpdatingStatus
                                ? "Updating…"
                                : "Update status"}
                            </button>
                          </form>
                          <p className="admin-order-status-warning">
                            Status changes cannot be undone.
                          </p>
                        </>
                      ) : (
                        <p className="admin-order-status-terminal-copy">
                          {isKnownTerminalStatus
                            ? "This order is in a terminal state and cannot be changed."
                            : "No status changes are available for this stored status. Refresh the order list or check the backend record."}
                        </p>
                      )}
                    </section>

                    {orderStatus === "CONFIRMED" && (
                      <section
                        className={`admin-order-pickup-failure-action ${
                          canMarkFailedToPickup
                            ? "admin-order-pickup-failure-action-ready"
                            : ""
                        }`}
                        aria-labelledby={`pickup-failure-action-title-${order.orderId}`}
                      >
                        <div>
                          <h4
                            id={`pickup-failure-action-title-${order.orderId}`}
                          >
                            Customer did not collect this order?
                          </h4>
                          <p id={`pickup-failure-action-help-${order.orderId}`}>
                            {!confirmedPickupTime
                              ? "This action is unavailable because the confirmed pickup time is missing or invalid."
                              : canMarkFailedToPickup
                                ? "This action records a failed pickup in the customer's history and cannot be undone."
                                : `Your device shows that pickup is scheduled for ${formatPickupTime(
                                    confirmedPickupTime,
                                  )}. The server will verify the time before recording a failure.`}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="button button-small button-danger"
                          onClick={() =>
                            openPickupFailureDialog(order.orderId)
                          }
                          disabled={
                            !confirmedPickupTime || isUpdatingStatus
                          }
                          aria-describedby={`pickup-failure-action-help-${order.orderId}`}
                        >
                          {isUpdatingStatus
                            ? "Updating..."
                            : "Mark as not picked up"}
                        </button>
                      </section>
                    )}

                    <section className="admin-order-failure-history">
                      <div className="admin-order-failure-history-heading">
                        <div>
                          <h4>Customer pickup history</h4>
                          <p>
                            Review this customer&apos;s recorded failed pickups.
                          </p>
                        </div>
                        <button
                          type="button"
                          className="button button-small button-quiet"
                          onClick={() =>
                            toggleAdminPickupFailureHistory(order.orderId)
                          }
                          aria-expanded={Boolean(
                            pickupFailureHistory?.isOpen,
                          )}
                          aria-controls={pickupFailureHistoryId}
                        >
                          {pickupFailureHistory?.isOpen
                            ? "Hide history"
                            : pickupFailureHistory?.hasLoaded &&
                                Number.isSafeInteger(
                                  pickupFailureHistory.failedPickupCount,
                                )
                              ? `View history (${pickupFailureHistory.failedPickupCount})`
                              : "View customer history"}
                        </button>
                      </div>

                      {pickupFailureHistory?.isOpen && (
                        <div
                          id={pickupFailureHistoryId}
                          className="admin-order-failure-history-panel"
                        >
                          {pickupFailureHistory.isLoading &&
                          !pickupFailureHistory.hasLoaded ? (
                            <p
                              className="admin-order-failure-history-state"
                              role="status"
                            >
                              Loading pickup history...
                            </p>
                          ) : pickupFailureHistory.error ? (
                            <div
                              className="admin-order-failure-history-error"
                              role="alert"
                            >
                              <p>{pickupFailureHistory.error}</p>
                              <button
                                type="button"
                                className="button button-small button-quiet"
                                onClick={() =>
                                  loadAdminPickupFailureHistory(
                                    order.orderId,
                                    pickupFailureHistory.hasLoaded
                                      ? {
                                          append: true,
                                          nextToken:
                                            pickupFailureHistory.nextToken,
                                        }
                                      : {},
                                  )
                                }
                                disabled={pickupFailureHistory.isLoading}
                              >
                                Try again
                              </button>
                            </div>
                          ) : pickupFailureHistory.hasLoaded ? (
                            <>
                              <div className="admin-order-failure-history-summary">
                                <strong>
                                  {pickupFailureHistory.failedPickupCount}
                                </strong>
                                <span>
                                  {pickupFailureHistory.failedPickupCount === 1
                                    ? "failed pickup"
                                    : "failed pickups"}
                                </span>
                                {pickupFailureHistory.lastFailedPickupAt && (
                                  <span>
                                    Most recent:{" "}
                                    <time
                                      dateTime={
                                        pickupFailureHistory.lastFailedPickupAt
                                      }
                                    >
                                      {formatOrderDate(
                                        pickupFailureHistory.lastFailedPickupAt,
                                      )}
                                    </time>
                                  </span>
                                )}
                              </div>

                              {pickupFailureHistory.failures.length > 0 ? (
                                <ul className="admin-order-failure-history-list">
                                  {pickupFailureHistory.failures.map(
                                    (failure) => (
                                      <li key={failure.orderId}>
                                        <div>
                                          <span>Order</span>
                                          <strong>{failure.orderId}</strong>
                                        </div>
                                        <div>
                                          <span>Scheduled pickup</span>
                                          <time
                                            dateTime={
                                              failure.scheduledPickupTime
                                            }
                                          >
                                            {formatPickupTime(
                                              failure.scheduledPickupTime,
                                            )}
                                          </time>
                                        </div>
                                        <div>
                                          <span>Marked not picked up</span>
                                          <time
                                            dateTime={failure.failedPickupAt}
                                          >
                                            {formatOrderDate(
                                              failure.failedPickupAt,
                                            )}
                                          </time>
                                        </div>
                                      </li>
                                    ),
                                  )}
                                </ul>
                              ) : (
                                <p className="admin-order-failure-history-state">
                                  No failed pickups have been recorded for this
                                  customer.
                                </p>
                              )}

                              {pickupFailureHistory.nextToken && (
                                <button
                                  type="button"
                                  className="button button-small button-quiet admin-order-failure-history-more"
                                  onClick={() =>
                                    loadAdminPickupFailureHistory(
                                      order.orderId,
                                      {
                                        append: true,
                                        nextToken:
                                          pickupFailureHistory.nextToken,
                                      },
                                    )
                                  }
                                  disabled={pickupFailureHistory.isLoading}
                                >
                                  {pickupFailureHistory.isLoading
                                    ? "Loading..."
                                    : "Load more history"}
                                </button>
                              )}
                            </>
                          ) : null}
                        </div>
                      )}
                    </section>

                    <footer className="admin-order-card-footer">
                      <span>
                        {order.itemCount}{" "}
                        {Number(order.itemCount) === 1 ? "item" : "items"}
                      </span>
                      <div>
                        <span>Total</span>
                        <strong>{formatPriceCents(order.totalCents)}</strong>
                      </div>
                    </footer>
                  </details>
                );
              })}
            </div>
          )}

          {adminOrdersNextToken && (
            <div className="admin-orders-pagination">
              <button
                type="button"
                className="button button-quiet"
                onClick={() =>
                  loadAdminOrders({
                    append: true,
                    nextToken: adminOrdersNextToken,
                  })
                }
                disabled={isLoadingAdminOrders}
              >
                {isLoadingAdminOrders ? "Loading…" : "Load more orders"}
              </button>
            </div>
          )}
        </section>
      </Modal>

      <Modal
        isOpen={Boolean(pickupFailureDialog)}
        onClose={closePickupFailureDialog}
        titleId="pickup-failure-dialog-title"
        className="pickup-failure-modal"
      >
        <section
          className="modal-panel pickup-failure-dialog"
          aria-busy={isPickupFailureSubmitting}
        >
          <button
            type="button"
            className="modal-close"
            aria-label="Close failed pickup confirmation"
            onClick={closePickupFailureDialog}
            disabled={isPickupFailureSubmitting}
          >
            &times;
          </button>
          <div className="modal-kicker">
            <span className="brand-mark" aria-hidden="true" />
            Customer pickup record
          </div>
          <h2 id="pickup-failure-dialog-title">Mark as not picked up?</h2>
          <p className="modal-intro">
            This changes the order to a terminal status and adds a record to
            the customer&apos;s failed-pickup history.
          </p>

          <dl className="pickup-failure-dialog-details">
            <div>
              <dt>Order</dt>
              <dd>
                {pickupFailureDialogOrder?.orderId ||
                  pickupFailureDialog?.orderId ||
                  "Unavailable"}
              </dd>
            </div>
            <div>
              <dt>Scheduled pickup</dt>
              <dd>
                {pickupFailureDialogPickupTime ? (
                  <time dateTime={pickupFailureDialogPickupTime}>
                    {formatPickupTime(pickupFailureDialogPickupTime)}
                  </time>
                ) : (
                  "Unavailable"
                )}
              </dd>
            </div>
          </dl>

          <form
            className="pickup-failure-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              markAdminOrderFailedToPickup();
            }}
            noValidate
          >
            <label htmlFor="pickup-failure-restaurant-note">
              <span>
                Message to customer <em>(optional)</em>
              </span>
              <span>
                {(pickupFailureDialog?.restaurantNote || "").length}/
                {MAX_RESTAURANT_NOTE_LENGTH}
              </span>
            </label>
            <textarea
              id="pickup-failure-restaurant-note"
              rows="4"
              maxLength={MAX_RESTAURANT_NOTE_LENGTH}
              value={pickupFailureDialog?.restaurantNote || ""}
              onChange={(event) =>
                changePickupFailureNote(event.target.value)
              }
              disabled={isPickupFailureSubmitting}
              placeholder="For example: The order was not collected before closing."
              aria-invalid={Boolean(pickupFailureDialog?.error)}
              aria-describedby={
                pickupFailureDialog?.error
                  ? "pickup-failure-dialog-help pickup-failure-dialog-error"
                  : "pickup-failure-dialog-help"
              }
            />
            <p
              id="pickup-failure-dialog-help"
              className="pickup-failure-dialog-help"
            >
              This customer-visible message replaces the previous restaurant
              note. Leave it empty to remove the previous note.
            </p>

            {pickupFailureDialog?.error && (
              <p
                id="pickup-failure-dialog-error"
                className="pickup-failure-dialog-error"
                role="alert"
              >
                {pickupFailureDialog.error}
              </p>
            )}

            <p className="pickup-failure-dialog-warning">
              Confirm only after checking that the customer did not collect
              this order. This action increases their failed-pickup count and
              cannot be undone.
            </p>

            <div className="pickup-failure-dialog-actions">
              <button
                type="button"
                className="button button-small button-quiet"
                onClick={closePickupFailureDialog}
                disabled={isPickupFailureSubmitting}
                data-autofocus
              >
                Keep confirmed
              </button>
              <button
                type="submit"
                className="button button-small button-danger"
                disabled={
                  isPickupFailureSubmitting ||
                  !pickupFailureDialogOrder ||
                  !pickupFailureDialogPickupTime
                }
              >
                {isPickupFailureSubmitting
                  ? "Updating..."
                  : "Confirm failed pickup"}
              </button>
            </div>
          </form>
        </section>
      </Modal>

      <Modal
        isOpen={isAnnouncementsOpen}
        onClose={closeAnnouncementsAdmin}
        titleId="announcements-admin-title"
        className="announcement-admin-modal"
      >
        <section
          className="announcement-admin-panel"
          aria-busy={isLoadingAnnouncements || Boolean(announcementMutation)}
        >
          <header className="announcement-admin-header">
            <div>
              <p className="eyebrow">Admin workspace</p>
              <h2 id="announcements-admin-title">Announcements</h2>
              <p>
                Publish time-limited updates that appear above the restaurant
                homepage.
              </p>
            </div>
            <button
              type="button"
              className="modal-close announcement-admin-close"
              aria-label="Close announcement editor"
              onClick={closeAnnouncementsAdmin}
              disabled={Boolean(announcementMutation)}
            >
              ×
            </button>
          </header>

          <div className="announcement-admin-toolbar">
            <p>
              {adminAnnouncements.length === 1
                ? "1 announcement"
                : `${adminAnnouncements.length} announcements`}
            </p>
            <div>
              <button
                type="button"
                className="button button-small button-outline"
                onClick={loadAdminAnnouncements}
                disabled={
                  isLoadingAnnouncements || Boolean(announcementMutation)
                }
              >
                {isLoadingAnnouncements ? "Refreshing…" : "Refresh"}
              </button>
              <button
                type="button"
                className="button button-small button-dark"
                onClick={startNewAnnouncement}
                disabled={Boolean(announcementMutation)}
              >
                New announcement
              </button>
            </div>
          </div>

          {announcementError && (
            <div className="announcement-admin-alert" role="alert">
              <p>{announcementError}</p>
            </div>
          )}
          {announcementNotice && (
            <p className="form-success" role="status">
              {announcementNotice}
            </p>
          )}

          <div className="announcement-admin-layout">
            <aside
              className="announcement-admin-list"
              aria-label="Saved announcements"
            >
              {isLoadingAnnouncements && adminAnnouncements.length === 0 ? (
                <div className="announcement-admin-empty" role="status">
                  <span className="admin-orders-spinner" aria-hidden="true" />
                  <p>Loading announcements…</p>
                </div>
              ) : adminAnnouncements.length === 0 ? (
                <div className="announcement-admin-empty">
                  <p>No announcements yet.</p>
                  <span>Create a draft or publish the first restaurant update.</span>
                </div>
              ) : (
                adminAnnouncements.map((announcement) => (
                  <article
                    className={`announcement-admin-list-item ${
                      editingAnnouncementId === announcement.announcementId
                        ? "announcement-admin-list-item-active"
                        : ""
                    }`}
                    key={announcement.announcementId}
                  >
                    <button
                      type="button"
                      className="announcement-admin-select"
                      onClick={() => editAnnouncement(announcement)}
                      aria-pressed={
                        editingAnnouncementId === announcement.announcementId
                      }
                      disabled={Boolean(announcementMutation)}
                    >
                      <span className="announcement-admin-list-meta">
                        <span
                          className={`announcement-status announcement-status-${announcement.status.toLowerCase()}`}
                        >
                          {announcement.status === "PUBLISHED"
                            ? "Published"
                            : "Draft"}
                        </span>
                        <span>
                          {ANNOUNCEMENT_TYPE_LABELS[announcement.type]}
                        </span>
                      </span>
                      <strong>{announcement.title}</strong>
                      <small>
                        {formatAnnouncementWindow(
                          announcement.startsAt,
                          announcement.endsAt,
                        )}
                      </small>
                    </button>
                    <button
                      type="button"
                      className="announcement-delete-button"
                      onClick={() => deleteAnnouncement(announcement)}
                      disabled={Boolean(announcementMutation)}
                      aria-label={`Delete ${announcement.title}`}
                    >
                      {announcementMutation ===
                      `delete:${announcement.announcementId}`
                        ? "Deleting…"
                        : "Delete"}
                    </button>
                  </article>
                ))
              )}
            </aside>

            <form
              className="announcement-form"
              onSubmit={handleSaveAnnouncement}
              noValidate
            >
              <div className="announcement-form-heading">
                <div>
                  <p className="eyebrow">
                    {editingAnnouncementId ? "Edit announcement" : "New announcement"}
                  </p>
                  <h3>
                    {editingAnnouncementId
                      ? "Update this message"
                      : "Share an update"}
                  </h3>
                </div>
                {editingAnnouncementId && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={startNewAnnouncement}
                    disabled={Boolean(announcementMutation)}
                  >
                    Clear form
                  </button>
                )}
              </div>

              <div className="announcement-form-grid">
                <label className="announcement-form-field">
                  <span>Type</span>
                  <select
                    value={announcementForm.type}
                    onChange={(event) =>
                      updateAnnouncementForm("type", event.target.value)
                    }
                    aria-invalid={Boolean(announcementFormErrors.type)}
                    aria-describedby={
                      announcementFormErrors.type
                        ? "announcement-type-error"
                        : undefined
                    }
                    disabled={Boolean(announcementMutation)}
                  >
                    {ANNOUNCEMENT_TYPES.map(({ value, label }) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {announcementFormErrors.type && (
                    <small
                      className="field-error"
                      id="announcement-type-error"
                    >
                      {announcementFormErrors.type}
                    </small>
                  )}
                </label>

                <label className="announcement-form-field">
                  <span>Status</span>
                  <select
                    value={announcementForm.status}
                    onChange={(event) =>
                      updateAnnouncementForm("status", event.target.value)
                    }
                    aria-invalid={Boolean(announcementFormErrors.status)}
                    aria-describedby={
                      announcementFormErrors.status
                        ? "announcement-status-error"
                        : undefined
                    }
                    disabled={Boolean(announcementMutation)}
                  >
                    {ANNOUNCEMENT_STATUSES.map(({ value, label }) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {announcementFormErrors.status && (
                    <small
                      className="field-error"
                      id="announcement-status-error"
                    >
                      {announcementFormErrors.status}
                    </small>
                  )}
                </label>
              </div>

              <label className="announcement-form-field">
                <span>Title</span>
                <input
                  type="text"
                  maxLength={MAX_ANNOUNCEMENT_TITLE_LENGTH}
                  value={announcementForm.title}
                  onChange={(event) =>
                    updateAnnouncementForm("title", event.target.value)
                  }
                  aria-invalid={Boolean(announcementFormErrors.title)}
                  aria-describedby={
                    announcementFormErrors.title
                      ? "announcement-title-error"
                      : "announcement-title-count"
                  }
                  disabled={Boolean(announcementMutation)}
                  data-autofocus
                />
                <small
                  className={
                    announcementFormErrors.title
                      ? "field-error"
                      : "announcement-character-count"
                  }
                  id={
                    announcementFormErrors.title
                      ? "announcement-title-error"
                      : "announcement-title-count"
                  }
                >
                  {announcementFormErrors.title ||
                    `${announcementForm.title.length}/${MAX_ANNOUNCEMENT_TITLE_LENGTH}`}
                </small>
              </label>

              <label className="announcement-form-field">
                <span>Message</span>
                <textarea
                  rows="6"
                  maxLength={MAX_ANNOUNCEMENT_MESSAGE_LENGTH}
                  value={announcementForm.message}
                  onChange={(event) =>
                    updateAnnouncementForm("message", event.target.value)
                  }
                  aria-invalid={Boolean(announcementFormErrors.message)}
                  aria-describedby={
                    announcementFormErrors.message
                      ? "announcement-message-error"
                      : "announcement-message-count"
                  }
                  disabled={Boolean(announcementMutation)}
                />
                <small
                  className={
                    announcementFormErrors.message
                      ? "field-error"
                      : "announcement-character-count"
                  }
                  id={
                    announcementFormErrors.message
                      ? "announcement-message-error"
                      : "announcement-message-count"
                  }
                >
                  {announcementFormErrors.message ||
                    `${announcementForm.message.length}/${MAX_ANNOUNCEMENT_MESSAGE_LENGTH}`}
                </small>
              </label>

              {announcementForm.type === "DISCOUNT" && (
                <label className="announcement-form-field">
                  <span>Promo code (optional)</span>
                  <input
                    type="text"
                    maxLength={MAX_ANNOUNCEMENT_PROMO_CODE_LENGTH}
                    value={announcementForm.promoCode}
                    onChange={(event) =>
                      updateAnnouncementForm(
                        "promoCode",
                        event.target.value.toUpperCase(),
                      )
                    }
                    aria-invalid={Boolean(announcementFormErrors.promoCode)}
                    aria-describedby="announcement-promo-help"
                    disabled={Boolean(announcementMutation)}
                  />
                  <small
                    className={
                      announcementFormErrors.promoCode
                        ? "field-error"
                        : ""
                    }
                    id="announcement-promo-help"
                  >
                    {announcementFormErrors.promoCode ||
                      "Display only: this code does not change prices in the cart or order."}
                  </small>
                </label>
              )}

              <div className="announcement-form-grid announcement-form-dates">
                <label className="announcement-form-field">
                  <span>Starts</span>
                  <input
                    type="datetime-local"
                    step="60"
                    value={announcementForm.startsAt}
                    onChange={(event) =>
                      updateAnnouncementForm("startsAt", event.target.value)
                    }
                    aria-invalid={Boolean(announcementFormErrors.startsAt)}
                    aria-describedby={
                      announcementFormErrors.startsAt
                        ? "announcement-start-error"
                        : "announcement-time-help"
                    }
                    disabled={Boolean(announcementMutation)}
                  />
                  {announcementFormErrors.startsAt && (
                    <small
                      className="field-error"
                      id="announcement-start-error"
                    >
                      {announcementFormErrors.startsAt}
                    </small>
                  )}
                </label>

                <label className="announcement-form-field">
                  <span>Ends</span>
                  <input
                    type="datetime-local"
                    step="60"
                    value={announcementForm.endsAt}
                    onChange={(event) =>
                      updateAnnouncementForm("endsAt", event.target.value)
                    }
                    aria-invalid={Boolean(announcementFormErrors.endsAt)}
                    aria-describedby={
                      announcementFormErrors.endsAt
                        ? "announcement-end-error"
                        : "announcement-time-help"
                    }
                    disabled={Boolean(announcementMutation)}
                  />
                  {announcementFormErrors.endsAt && (
                    <small
                      className="field-error"
                      id="announcement-end-error"
                    >
                      {announcementFormErrors.endsAt}
                    </small>
                  )}
                </label>
              </div>
              <p className="announcement-time-help" id="announcement-time-help">
                Entered in this device’s local time and saved as UTC.
              </p>

              <label className="announcement-form-field announcement-priority-field">
                <span>Priority</span>
                <input
                  type="number"
                  min={MIN_ANNOUNCEMENT_PRIORITY}
                  max={MAX_ANNOUNCEMENT_PRIORITY}
                  step="1"
                  value={announcementForm.priority}
                  onChange={(event) =>
                    updateAnnouncementForm("priority", event.target.value)
                  }
                  aria-invalid={Boolean(announcementFormErrors.priority)}
                  aria-describedby={
                    announcementFormErrors.priority
                      ? "announcement-priority-error"
                      : "announcement-priority-help"
                  }
                  disabled={Boolean(announcementMutation)}
                />
                <small
                  className={
                    announcementFormErrors.priority ? "field-error" : ""
                  }
                  id={
                    announcementFormErrors.priority
                      ? "announcement-priority-error"
                      : "announcement-priority-help"
                  }
                >
                  {announcementFormErrors.priority ||
                    "Higher-priority announcements appear first."}
                </small>
              </label>

              <div className="announcement-form-actions">
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={startNewAnnouncement}
                  disabled={Boolean(announcementMutation)}
                >
                  Reset
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={Boolean(announcementMutation)}
                >
                  {announcementMutation === "save"
                    ? "Saving…"
                    : editingAnnouncementId
                      ? "Save changes"
                      : "Create announcement"}
                </button>
              </div>
            </form>
          </div>
        </section>
      </Modal>

      <Modal
        isOpen={isSignInModalOpen}
        onClose={closeSignIn}
        titleId="sign-in-title"
        className="auth-modal"
      >
        <div className="modal-panel" ref={authPanelRef}>
          <button
            type="button"
            className="modal-close"
            aria-label="Close account dialog"
            onClick={closeSignIn}
            disabled={isAuthBusy}
          >
            ×
          </button>
          <div className="modal-kicker">
            <span className="brand-mark" aria-hidden="true" />
            {authView === "forgotPassword" || authView === "resetPassword"
              ? "Account recovery"
              : isAdminSignIn
                ? "Snowfox administration"
                : authView === "signUp"
                  ? "Snowfox customer registration"
                  : authView === "confirm"
                    ? "Email verification"
                    : "Snowfox customer account"}
          </div>
          <h2 id="sign-in-title">
            {authView === "signUp"
              ? "Create your account."
              : authView === "confirm"
                ? "Confirm your email."
                : authView === "forgotPassword"
                  ? "Reset your password."
                  : authView === "resetPassword"
                    ? "Choose a new password."
                    : isAdminSignIn
                      ? "Welcome back."
                      : isChatSignIn
                        ? "Sign in to chat."
                        : isOrderSignIn
                          ? "Sign in to order."
                          : "Welcome to Snowfox."}
          </h2>
          <p className="modal-intro">
            {authView === "signUp"
              ? "Register with your name, phone number, and email, then verify your email using the code Cognito sends you."
              : authView === "confirm"
                ? "Enter the email address you registered and the 6-digit confirmation code."
                : authView === "forgotPassword"
                  ? "Enter your verified account email and Cognito will send a 6-digit reset code."
                  : authView === "resetPassword"
                    ? "Enter the code from your email and create a new password."
                    : isAdminSignIn
                      ? "Sign in with your existing admin account to manage the restaurant menu."
                      : isChatSignIn
                        ? "Use your Snowfox customer account to start a private chat session."
                        : isOrderSignIn
                          ? "Sign in to review and submit your pickup order."
                          : "Sign in to your customer account, or create one if this is your first visit."}
          </p>

          {signInError && (
            <p className="form-alert" role="alert">
              {signInError}
            </p>
          )}

          {authMessage && (
            <p className="form-success" role="status">
              {authMessage}
            </p>
          )}

          {authView === "signIn" && (
            <>
              <form
                className="auth-form"
                onSubmit={handleSignInSubmit}
                aria-busy={isSigningIn}
                noValidate
              >
                <label htmlFor="signInEmail">Email address</label>
                <input
                  id="signInEmail"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={signInValues.email}
                  onChange={handleSignInChange}
                  aria-invalid={Boolean(signInErrors.email)}
                  aria-describedby={
                    signInErrors.email ? "signInEmail-error" : undefined
                  }
                  disabled={isAuthBusy}
                  data-autofocus
                />
                {signInErrors.email && (
                  <p className="field-error" id="signInEmail-error">
                    {signInErrors.email}
                  </p>
                )}

                <label htmlFor="signInPassword">Password</label>
                <div className="password-field">
                  <input
                    id="signInPassword"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={signInValues.password}
                    onChange={handleSignInChange}
                    aria-invalid={Boolean(signInErrors.password)}
                    aria-describedby={
                      signInErrors.password ? "signInPassword-error" : undefined
                    }
                    disabled={isAuthBusy}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    disabled={isAuthBusy}
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
                {signInErrors.password && (
                  <p className="field-error" id="signInPassword-error">
                    {signInErrors.password}
                  </p>
                )}

                <button
                  className="button button-primary auth-submit"
                  type="submit"
                  disabled={isAuthBusy}
                >
                  {isSigningIn ? "Signing in…" : "Sign in to Snowfox"}
                  <span aria-hidden="true">→</span>
                </button>
              </form>

              <div className="auth-switches">
                <p className="auth-switch">
                  Forgot your password?
                  <button
                    type="button"
                    className="auth-link-button"
                    onClick={() => showForgotPassword(signInValues.email)}
                    disabled={isAuthBusy}
                  >
                    Reset password
                  </button>
                </p>
                {!isAdminSignIn && (
                  <>
                    <p className="auth-switch">
                      New to Snowfox?
                      <button
                        type="button"
                        className="auth-link-button"
                        onClick={showSignUp}
                        disabled={isAuthBusy}
                      >
                        Create account
                      </button>
                    </p>
                    <p className="auth-switch">
                      Already have a confirmation code?
                      <button
                        type="button"
                        className="auth-link-button"
                        onClick={() => showConfirmation()}
                        disabled={isAuthBusy}
                      >
                        Confirm email
                      </button>
                    </p>
                  </>
                )}
              </div>
            </>
          )}

          {authView === "forgotPassword" && (
            <>
              <form
                className="auth-form"
                onSubmit={handlePasswordResetRequest}
                aria-busy={isRequestingPasswordReset}
                noValidate
              >
                <label htmlFor="passwordResetEmail">Email address</label>
                <input
                  id="passwordResetEmail"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={passwordResetValues.email}
                  onChange={handlePasswordResetChange}
                  aria-invalid={Boolean(passwordResetErrors.email)}
                  aria-describedby={
                    passwordResetErrors.email
                      ? "passwordResetEmail-error"
                      : undefined
                  }
                  disabled={isAuthBusy}
                  data-autofocus
                />
                {passwordResetErrors.email && (
                  <p className="field-error" id="passwordResetEmail-error">
                    {passwordResetErrors.email}
                  </p>
                )}

                <button
                  className="button button-primary auth-submit"
                  type="submit"
                  disabled={isAuthBusy}
                >
                  {isRequestingPasswordReset
                    ? "Sending code…"
                    : "Send reset code"}
                  <span aria-hidden="true">→</span>
                </button>
              </form>

              <div className="auth-secondary-actions">
                <button
                  type="button"
                  className="auth-link-button"
                  onClick={showSignIn}
                  disabled={isAuthBusy}
                >
                  Back to sign in
                </button>
              </div>
            </>
          )}

          {authView === "resetPassword" && (
            <>
              <form
                className="auth-form"
                onSubmit={handlePasswordResetSubmit}
                aria-busy={
                  isResettingPassword || isRequestingPasswordReset
                }
                noValidate
              >
                <label htmlFor="resetAccountEmail">Email address</label>
                <input
                  id="resetAccountEmail"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={passwordResetValues.email}
                  readOnly
                  aria-readonly="true"
                  aria-invalid={Boolean(passwordResetErrors.email)}
                  aria-describedby={
                    passwordResetErrors.email
                      ? "resetAccountEmail-error"
                      : undefined
                  }
                  disabled={isAuthBusy}
                />
                {passwordResetErrors.email && (
                  <p className="field-error" id="resetAccountEmail-error">
                    {passwordResetErrors.email}
                  </p>
                )}

                <label htmlFor="passwordResetCode">Reset code</label>
                <input
                  id="passwordResetCode"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={passwordResetValues.code}
                  onChange={handlePasswordResetChange}
                  aria-invalid={Boolean(passwordResetErrors.code)}
                  aria-describedby={
                    passwordResetErrors.code
                      ? "passwordResetCode-error"
                      : undefined
                  }
                  disabled={isAuthBusy}
                  data-autofocus
                />
                {passwordResetErrors.code && (
                  <p className="field-error" id="passwordResetCode-error">
                    {passwordResetErrors.code}
                  </p>
                )}

                <label htmlFor="newPassword">New password</label>
                <div className="password-field">
                  <input
                    id="newPassword"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={passwordResetValues.password}
                    onChange={handlePasswordResetChange}
                    aria-invalid={Boolean(passwordResetErrors.password)}
                    aria-describedby={
                      passwordResetErrors.password
                        ? "newPassword-help newPassword-error"
                        : "newPassword-help"
                    }
                    disabled={isAuthBusy}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    disabled={isAuthBusy}
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
                <p className="auth-helper" id="newPassword-help">
                  Use at least 8 characters with uppercase, lowercase, and a
                  number.
                </p>
                {passwordResetErrors.password && (
                  <p className="field-error" id="newPassword-error">
                    {passwordResetErrors.password}
                  </p>
                )}

                <label htmlFor="confirmNewPassword">
                  Confirm new password
                </label>
                <input
                  id="confirmNewPassword"
                  name="confirmPassword"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={passwordResetValues.confirmPassword}
                  onChange={handlePasswordResetChange}
                  aria-invalid={Boolean(
                    passwordResetErrors.confirmPassword
                  )}
                  aria-describedby={
                    passwordResetErrors.confirmPassword
                      ? "confirmNewPassword-error"
                      : undefined
                  }
                  disabled={isAuthBusy}
                />
                {passwordResetErrors.confirmPassword && (
                  <p className="field-error" id="confirmNewPassword-error">
                    {passwordResetErrors.confirmPassword}
                  </p>
                )}

                <button
                  className="button button-primary auth-submit"
                  type="submit"
                  disabled={isAuthBusy}
                >
                  {isResettingPassword
                    ? "Resetting password…"
                    : "Reset password"}
                  <span aria-hidden="true">→</span>
                </button>
              </form>

              <div className="auth-secondary-actions">
                <button
                  type="button"
                  className="auth-link-button"
                  onClick={showSignIn}
                  disabled={isAuthBusy}
                >
                  Back to sign in
                </button>
                <button
                  type="button"
                  className="auth-link-button"
                  onClick={() => showForgotPassword("")}
                  disabled={isAuthBusy}
                >
                  Change email
                </button>
                <button
                  type="button"
                  className="auth-link-button"
                  onClick={handleResendPasswordResetCode}
                  disabled={isAuthBusy}
                >
                  {isRequestingPasswordReset ? "Sending…" : "Resend code"}
                </button>
              </div>
            </>
          )}

          {authView === "signUp" && (
            <>
              <form
                className="auth-form"
                onSubmit={handleSignUpSubmit}
                aria-busy={isSigningUp}
                noValidate
              >
                <label htmlFor="signUpFullName">Full name</label>
                <input
                  id="signUpFullName"
                  name="fullName"
                  type="text"
                  autoComplete="name"
                  maxLength={MAX_CUSTOMER_NAME_LENGTH}
                  value={signUpValues.fullName}
                  onChange={handleSignUpChange}
                  aria-invalid={Boolean(signUpErrors.fullName)}
                  aria-describedby={
                    signUpErrors.fullName ? "signUpFullName-error" : undefined
                  }
                  disabled={isAuthBusy}
                  data-autofocus
                />
                {signUpErrors.fullName && (
                  <p className="field-error" id="signUpFullName-error">
                    {signUpErrors.fullName}
                  </p>
                )}

                <label htmlFor="signUpEmail">Email address</label>
                <input
                  id="signUpEmail"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={signUpValues.email}
                  onChange={handleSignUpChange}
                  aria-invalid={Boolean(signUpErrors.email)}
                  aria-describedby={
                    signUpErrors.email ? "signUpEmail-error" : undefined
                  }
                  disabled={isAuthBusy}
                />
                {signUpErrors.email && (
                  <p className="field-error" id="signUpEmail-error">
                    {signUpErrors.email}
                  </p>
                )}

                <label htmlFor="signUpPhoneNumber">Phone number</label>
                <input
                  id="signUpPhoneNumber"
                  name="phoneNumber"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={24}
                  placeholder="+1 415 555 2671"
                  value={signUpValues.phoneNumber}
                  onChange={handleSignUpChange}
                  aria-invalid={Boolean(signUpErrors.phoneNumber)}
                  aria-describedby={
                    signUpErrors.phoneNumber
                      ? "signUpPhoneNumber-help signUpPhoneNumber-error"
                      : "signUpPhoneNumber-help"
                  }
                  disabled={isAuthBusy}
                />
                <p className="auth-helper" id="signUpPhoneNumber-help">
                  Include the country code. Spaces, parentheses, and dashes are
                  accepted.
                </p>
                {signUpErrors.phoneNumber && (
                  <p className="field-error" id="signUpPhoneNumber-error">
                    {signUpErrors.phoneNumber}
                  </p>
                )}

                <label htmlFor="signUpPassword">Password</label>
                <div className="password-field">
                  <input
                    id="signUpPassword"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={signUpValues.password}
                    onChange={handleSignUpChange}
                    aria-invalid={Boolean(signUpErrors.password)}
                    aria-describedby={
                      signUpErrors.password
                        ? "signUpPassword-help signUpPassword-error"
                        : "signUpPassword-help"
                    }
                    disabled={isAuthBusy}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    disabled={isAuthBusy}
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
                <p className="auth-helper" id="signUpPassword-help">
                  Use at least 8 characters with uppercase, lowercase, and a
                  number.
                </p>
                {signUpErrors.password && (
                  <p className="field-error" id="signUpPassword-error">
                    {signUpErrors.password}
                  </p>
                )}

                <label htmlFor="confirmPassword">Confirm password</label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={signUpValues.confirmPassword}
                  onChange={handleSignUpChange}
                  aria-invalid={Boolean(signUpErrors.confirmPassword)}
                  aria-describedby={
                    signUpErrors.confirmPassword
                      ? "confirmPassword-error"
                      : undefined
                  }
                  disabled={isAuthBusy}
                />
                {signUpErrors.confirmPassword && (
                  <p className="field-error" id="confirmPassword-error">
                    {signUpErrors.confirmPassword}
                  </p>
                )}

                <button
                  className="button button-primary auth-submit"
                  type="submit"
                  disabled={isAuthBusy}
                >
                  {isSigningUp ? "Creating account…" : "Create account"}
                  <span aria-hidden="true">→</span>
                </button>
              </form>

              <div className="auth-secondary-actions">
                <button
                  type="button"
                  className="auth-link-button"
                  onClick={showSignIn}
                  disabled={isAuthBusy}
                >
                  Back to sign in
                </button>
                <button
                  type="button"
                  className="auth-link-button"
                  onClick={() => showConfirmation(signUpValues.email)}
                  disabled={isAuthBusy}
                >
                  I have a code
                </button>
              </div>
            </>
          )}

          {authView === "confirm" && (
            <>
              <form
                className="auth-form"
                onSubmit={handleConfirmationSubmit}
                aria-busy={isConfirming}
                noValidate
              >
                <label htmlFor="confirmationEmail">Email address</label>
                <input
                  id="confirmationEmail"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={confirmationValues.email}
                  onChange={handleConfirmationChange}
                  aria-invalid={Boolean(confirmationErrors.email)}
                  aria-describedby={
                    confirmationErrors.email
                      ? "confirmationEmail-error"
                      : undefined
                  }
                  disabled={isAuthBusy}
                  data-autofocus={
                    confirmationValues.email ? undefined : ""
                  }
                />
                {confirmationErrors.email && (
                  <p className="field-error" id="confirmationEmail-error">
                    {confirmationErrors.email}
                  </p>
                )}

                <label htmlFor="confirmationCode">Confirmation code</label>
                <input
                  id="confirmationCode"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength="6"
                  autoComplete="one-time-code"
                  value={confirmationValues.code}
                  onChange={handleConfirmationChange}
                  aria-invalid={Boolean(confirmationErrors.code)}
                  aria-describedby={
                    confirmationErrors.code
                      ? "confirmationCode-error"
                      : undefined
                  }
                  disabled={isAuthBusy}
                  data-autofocus={confirmationValues.email ? "" : undefined}
                />
                {confirmationErrors.code && (
                  <p className="field-error" id="confirmationCode-error">
                    {confirmationErrors.code}
                  </p>
                )}

                <button
                  className="button button-primary auth-submit"
                  type="submit"
                  disabled={isAuthBusy}
                >
                  {isConfirming ? "Confirming…" : "Confirm email"}
                  <span aria-hidden="true">→</span>
                </button>
              </form>

              <div className="auth-secondary-actions">
                <button
                  type="button"
                  className="auth-link-button"
                  onClick={showSignIn}
                  disabled={isAuthBusy}
                >
                  Back to sign in
                </button>
                <button
                  type="button"
                  className="auth-link-button"
                  onClick={handleResendConfirmationCode}
                  disabled={isAuthBusy}
                >
                  {isResendingCode ? "Sending…" : "Resend code"}
                </button>
              </div>
            </>
          )}

          <p className="modal-footnote">
            {authView === "signUp"
              ? "Your account is ready after email verification."
              : authView === "confirm"
                ? "Check your spam folder if the email does not arrive."
                : authView === "forgotPassword" ||
                    authView === "resetPassword"
                  ? "Reset codes expire after one hour. Check your spam folder if the email does not arrive."
                  : isAdminSignIn
                    ? "Menu access is limited to restaurant team members."
                    : "Authentication is securely handled by Amazon Cognito."}
          </p>
        </div>
      </Modal>

      <Modal
        isOpen={isChatOpen && isAuthenticated}
        onClose={() => setIsChatOpen(false)}
        titleId="chat-title"
        className="chat-modal"
      >
        <section className="chat-panel">
          <header className="chat-header">
            <button
              type="button"
              className="modal-close"
              aria-label="Close chat"
              onClick={() => setIsChatOpen(false)}
            >
              &times;
            </button>

            <div className="modal-kicker">
              <span className="brand-mark" aria-hidden="true" />
              Snowfox dining assistant
            </div>
            <div className="chat-title-row">
              <h2 id="chat-title">Ask Snowfox</h2>
              <span
                className={`chat-status-badge chat-status-badge-${
                  isCreatingChat
                    ? "connecting"
                    : activeChat
                      ? "live"
                      : "unavailable"
                }`}
              >
                {isCreatingChat
                  ? "Connecting"
                  : activeChat
                    ? "Live"
                    : "Unavailable"}
              </span>
            </div>
            <div className="chat-session-row">
              <div className="chat-id">
                <span>Chat ID</span>
                <code title={activeChat?.id || ""}>
                  {activeChat?.id ||
                    (isCreatingChat ? "Creating session..." : "Not connected")}
                </code>
              </div>
              <button
                type="button"
                className="chat-new-button"
                onClick={startNewChat}
                disabled={isCreatingChat || isSendingChatMessage}
              >
                {isCreatingChat ? "Starting..." : "New chat"}
              </button>
            </div>
          </header>

          <div
            ref={chatLogRef}
            className="chat-message-list"
            role="log"
            aria-label="Chat messages"
            aria-live="polite"
            aria-relevant="additions"
            aria-busy={isCreatingChat || isSendingChatMessage}
          >
            {isCreatingChat && !activeChat ? (
              <p className="chat-state" role="status">
                Starting a secure chat session...
              </p>
            ) : null}
            {!isCreatingChat &&
            activeChat &&
            activeChat.messages.length === 0 ? (
              <p className="chat-state">
                Your chat is ready. Ask about dishes, ingredients, allergens,
                or availability.
              </p>
            ) : null}
            {activeChat?.messages.map((message) => (
              <article
                className={`chat-message chat-message-${message.role}`}
                key={message.id}
              >
                <p className="chat-message-meta">
                  {message.role === "user" ? "You" : "Snowfox assistant"}
                </p>
                <p className="chat-message-content">{message.content}</p>
              </article>
            ))}
            {isSendingChatMessage ? (
              <article className="chat-message chat-message-assistant chat-message-pending">
                <p className="chat-message-meta">Snowfox assistant</p>
                <p className="chat-message-content" role="status">
                  Checking the live menu...
                </p>
              </article>
            ) : null}
            {chatError ? (
              <p className="chat-error" role="alert">
                {chatError}
              </p>
            ) : null}
          </div>

          <form className="chat-composer" onSubmit={handleChatSubmit}>
            <label className="sr-only" htmlFor="chatMessage">
              Message Snowfox
            </label>
            <textarea
              id="chatMessage"
              rows="2"
              maxLength="1000"
              placeholder="Ask about the menu, ingredients, or your visit..."
              value={chatDraft}
              onChange={(event) => {
                setChatDraft(event.target.value);
                setChatError("");
              }}
              disabled={
                !activeChat || isCreatingChat || isSendingChatMessage
              }
              data-autofocus
            />
            <button
              className="chat-send-button"
              type="submit"
              disabled={
                !chatDraft.trim() ||
                !activeChat ||
                isCreatingChat ||
                isSendingChatMessage
              }
            >
              {isSendingChatMessage ? "Sending..." : "Send"}
            </button>
            <p className="chat-live-note">
              {activeChat
                ? "Connected to the live Snowfox menu assistant."
                : "A server-created chat session is required before sending."}
            </p>
          </form>

          <footer className="chat-account">
            <p>
              Signed in as <strong>{currentUserEmail}</strong>
            </p>
            <button
              type="button"
              className="text-button"
              onClick={handleSignOut}
            >
              Sign out
            </button>
          </footer>
        </section>
      </Modal>

      <Modal
        isOpen={isEditorOpen}
        onClose={closeMenuEditor}
        titleId="menu-editor-title"
        className="editor-modal"
      >
        <form
          className="editor-panel"
          onSubmit={handleSaveMenu}
          aria-busy={isSavingMenu}
        >
          <div className="editor-header">
            <div>
              <p className="eyebrow">Admin workspace</p>
              <h2 id="menu-editor-title">Edit the menu</h2>
              <p>Updates are reflected on this page as soon as you save.</p>
            </div>
            <button
              type="button"
              className="modal-close"
              aria-label="Close menu editor"
              onClick={closeMenuEditor}
              disabled={isSavingMenu}
            >
              ×
            </button>
          </div>

          {editorError && (
            <p className="form-alert" role="alert">
              {editorError}
            </p>
          )}

          <div className="editor-list">
            {draftMenuItems.map((item, index) => {
              const pendingImage = pendingDishImages[item.id];
              const savedImageUrl = getDishImageUrl(item.image);
              const previewUrl = pendingImage?.previewUrl || savedImageUrl;
              const imageInputId = `dish-image-${item.id}`;
              const imageHelpId = `dish-image-help-${item.id}`;
              const imageAltHelpId = `dish-image-alt-help-${item.id}`;
              const imageAlt = pendingImage?.alt ?? item.image?.alt ?? "";

              return (
              <fieldset
                className="editor-item"
                key={item.id}
                disabled={isSavingMenu}
              >
                <legend>Dish {String(index + 1).padStart(2, "0")}</legend>
                <div className="editor-row editor-row-compact">
                  <label>
                    <span>Category</span>
                    <input
                      type="text"
                      value={item.category}
                      onChange={(event) =>
                        updateDraftItem(item.id, "category", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    <span>Price</span>
                    <div className="price-input">
                      <span aria-hidden="true">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.price}
                        onChange={(event) =>
                          updateDraftItem(item.id, "price", event.target.value)
                        }
                        aria-label={`Price for ${item.name || `dish ${index + 1}`}`}
                      />
                    </div>
                  </label>
                </div>
                <label className="availability-field">
                  <span>Availability</span>
                  <select
                    className={`availability-select availability-select-${item.availability}`}
                    value={item.availability}
                    onChange={(event) =>
                      updateDraftItem(
                        item.id,
                        "availability",
                        event.target.value,
                      )
                    }
                  >
                    <option value="available">Available</option>
                    <option value="out">Out</option>
                  </select>
                </label>
                <label>
                  <span>Dish name</span>
                  <input
                    type="text"
                    value={item.name}
                    onChange={(event) =>
                      updateDraftItem(item.id, "name", event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Description</span>
                  <textarea
                    rows="2"
                    value={item.description}
                    onChange={(event) =>
                      updateDraftItem(item.id, "description", event.target.value)
                    }
                  />
                </label>

                <div className="dish-image-field">
                  <div className="dish-image-heading">
                    <span>Dish image</span>
                    <span className="optional-badge">Optional</span>
                  </div>
                  <p className="editor-help" id={imageHelpId}>
                    JPEG, PNG, or WebP, up to 5 MiB. A selected file uploads only
                    when the menu is saved. For faster loading, prefer an
                    approximately 800px-wide WebP under 300 KiB.
                  </p>

                  {previewUrl ? (
                    <div className="dish-image-preview">
                      <img
                        src={previewUrl}
                        alt={
                          imageAlt.trim()
                            ? `${imageAlt.trim()} preview`
                            : "Dish image preview"
                        }
                      />
                      <span>
                        {pendingImage?.uploadedImage
                          ? "Upload ready"
                          : pendingImage
                            ? "Pending upload"
                            : "Current image"}
                      </span>
                    </div>
                  ) : (
                    <div className="dish-image-placeholder">
                      {item.image
                        ? "The current image is saved, but its preview URL is not configured."
                        : "No image selected"}
                    </div>
                  )}

                  {pendingImage && (
                    <p className="dish-image-file-status" aria-live="polite">
                      <strong>{pendingImage.file.name}</strong>
                      <span>
                        {(pendingImage.file.size / (1024 * 1024)).toFixed(1)} MiB
                        {pendingImage.uploadedImage
                          ? " / uploaded and waiting for the menu save"
                          : item.image
                            ? " / replaces the current image after Save"
                            : " / uploads after Save"}
                      </span>
                    </p>
                  )}

                  <div className="dish-image-controls">
                    <input
                      className="sr-only dish-image-file-input"
                      id={imageInputId}
                      type="file"
                      accept={DISH_IMAGE_ACCEPT}
                      aria-describedby={imageHelpId}
                      onChange={(event) =>
                        handleDraftImageSelection(item.id, event)
                      }
                    />
                    <label className="dish-image-picker" htmlFor={imageInputId}>
                      {pendingImage
                        ? "Choose different image"
                        : item.image
                          ? "Replace image"
                          : "Choose image"}
                    </label>
                    {pendingImage && (
                      <button
                        type="button"
                        className="dish-image-action"
                        onClick={() => discardPendingDishImage(item.id)}
                      >
                        {item.image ? "Cancel replacement" : "Cancel selection"}
                      </button>
                    )}
                    {item.image && !pendingImage && (
                      <button
                        type="button"
                        className="dish-image-action dish-image-remove"
                        onClick={() => removeDraftDishImage(item.id)}
                      >
                        Remove image
                      </button>
                    )}
                  </div>

                  {(pendingImage || item.image) && (
                    <label className="dish-image-alt">
                      <span>Alternative text</span>
                      <input
                        type="text"
                        maxLength={MAX_DISH_IMAGE_ALT_LENGTH}
                        value={imageAlt}
                        aria-describedby={imageAltHelpId}
                        onChange={(event) => {
                          if (pendingImage) {
                            updatePendingDishImageAlt(
                              item.id,
                              event.target.value,
                            );
                          } else {
                            updateDraftDishImageAlt(
                              item.id,
                              event.target.value,
                            );
                          }
                        }}
                      />
                      <small id={imageAltHelpId}>
                        Briefly describe the dish for guests using screen readers.
                      </small>
                    </label>
                  )}
                </div>

                <fieldset
                  className="allergen-fieldset"
                  aria-describedby={`allergen-help-${item.id}`}
                >
                  <legend>Allergy information</legend>
                  <p
                    className="editor-help"
                    id={`allergen-help-${item.id}`}
                  >
                    Select every known allergen for this dish and verify it with
                    the kitchen.
                  </p>
                  <div className="allergen-options">
                    {ALLERGEN_OPTIONS.map(({ value, label }) => (
                      <label className="allergen-option" key={value}>
                        <input
                          type="checkbox"
                          checked={item.allergens.includes(value)}
                          onChange={(event) =>
                            toggleDraftAllergen(
                              item.id,
                              value,
                              event.target.checked,
                            )
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="rag-field">
                  <div className="rag-field-heading">
                    <label htmlFor={`full-dish-info-${item.id}`}>
                      Additional information for AI answers
                    </label>
                    <span className="private-badge">Private</span>
                  </div>
                  <p className="editor-help" id={`full-dish-info-help-${item.id}`}>
                    Used by the future RAG service and excluded from the public
                    menu API.
                  </p>
                  <textarea
                    id={`full-dish-info-${item.id}`}
                    rows="4"
                    maxLength={MAX_FULL_DISH_INFO_LENGTH}
                    value={item.fullDishInfo}
                    onChange={(event) =>
                      updateDraftItem(item.id, "fullDishInfo", event.target.value)
                    }
                    aria-describedby={`full-dish-info-help-${item.id}`}
                  />
                  <p className="rag-character-count">
                    {item.fullDishInfo.length.toLocaleString()} /{" "}
                    {MAX_FULL_DISH_INFO_LENGTH.toLocaleString()}
                  </p>
                </div>

                <button
                  type="button"
                  className="remove-dish"
                  onClick={() => removeDraftItem(item.id)}
                  disabled={draftMenuItems.length === 1}
                >
                  Remove dish
                </button>
              </fieldset>
              );
            })}
          </div>

          <button
            type="button"
            className="add-dish"
            onClick={addDraftItem}
            disabled={isSavingMenu}
          >
            <span aria-hidden="true">+</span> Add another dish
          </button>

          <div className="editor-actions">
            {editorError && (
              <p className="editor-action-error">{editorError}</p>
            )}
            <button
              type="button"
              className="text-button"
              onClick={restoreDraftDefaults}
              disabled={isSavingMenu}
            >
              Restore sample menu
            </button>
            <div>
              <button
                type="button"
                className="button button-quiet"
                onClick={closeMenuEditor}
                disabled={isSavingMenu}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={isSavingMenu}
              >
                {isSavingMenu ? "Saving…" : "Save menu"}
              </button>
            </div>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default App;
