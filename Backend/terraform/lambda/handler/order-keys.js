"use strict";

const CUSTOMER_ORDER_KEY_PREFIX = "CUSTOMER#";

const customerOrderKeyFor = (customerId) =>
  `${CUSTOMER_ORDER_KEY_PREFIX}${customerId}`;

exports.CUSTOMER_ORDER_KEY_PREFIX = CUSTOMER_ORDER_KEY_PREFIX;
exports.customerOrderKeyFor = customerOrderKeyFor;
