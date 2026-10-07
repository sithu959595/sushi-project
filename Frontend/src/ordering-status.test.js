import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ORDERING_PAUSED_MESSAGE,
  MAX_ORDERING_STATUS_MESSAGE_LENGTH,
  getOrderingPausedMessage,
  isOrderingActionBlocked,
  normalizeOrderingStatus,
} from "./ordering-status.js";

test("normalizes an active ordering status with missing optional metadata", () => {
  assert.deepEqual(
    normalizeOrderingStatus({ acceptingOrders: true, message: "" }),
    {
      acceptingOrders: true,
      message: "",
      updatedAt: "",
      updatedBy: "",
    },
  );
});

test("normalizes and trims a paused ordering status", () => {
  assert.deepEqual(
    normalizeOrderingStatus({
      acceptingOrders: false,
      message: "  Closed for maintenance.  ",
      updatedAt: " 2026-07-31T12:00:00Z ",
      updatedBy: " admin@example.com ",
    }),
    {
      acceptingOrders: false,
      message: "Closed for maintenance.",
      updatedAt: "2026-07-31T12:00:00Z",
      updatedBy: "admin@example.com",
    },
  );
});

test("rejects malformed or incomplete paused statuses", () => {
  assert.throws(() => normalizeOrderingStatus(null), /invalid response/i);
  assert.throws(
    () => normalizeOrderingStatus({ acceptingOrders: "yes", message: "" }),
    /acceptingOrders/i,
  );
  assert.throws(
    () => normalizeOrderingStatus({ acceptingOrders: false, message: "   " }),
    /without a message/i,
  );
  assert.throws(
    () =>
      normalizeOrderingStatus({
        acceptingOrders: false,
        message: "x".repeat(MAX_ORDERING_STATUS_MESSAGE_LENGTH + 1),
      }),
    /too long/i,
  );
});

test("uses a safe customer message when an upstream error omits one", () => {
  assert.equal(getOrderingPausedMessage("  Back tomorrow. "), "Back tomorrow.");
  assert.equal(
    getOrderingPausedMessage(""),
    "Online ordering is temporarily paused.",
  );
  assert.equal(
    DEFAULT_ORDERING_PAUSED_MESSAGE,
    "Online ordering is temporarily paused.",
  );
});

test("blocks configured ordering until status is ready and accepting", () => {
  for (const requestState of ["unknown", "loading", "error"]) {
    assert.equal(
      isOrderingActionBlocked({
        apiConfigured: true,
        requestState,
        acceptingOrders: true,
      }),
      true,
    );
  }

  assert.equal(
    isOrderingActionBlocked({
      apiConfigured: true,
      requestState: "ready",
      acceptingOrders: false,
    }),
    true,
  );
  assert.equal(
    isOrderingActionBlocked({
      apiConfigured: true,
      requestState: "ready",
      acceptingOrders: true,
    }),
    false,
  );
});

test("keeps API-less preview ordering usable", () => {
  assert.equal(
    isOrderingActionBlocked({
      apiConfigured: false,
      requestState: "loading",
      acceptingOrders: false,
    }),
    false,
  );
});
