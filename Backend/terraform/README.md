# Sushi dishes API

This Terraform stack creates an API for loading and saving the sushi restaurant
dishes used by the frontend.

## Dish format

Dish writes use the frontend's core fields plus optional structured allergy and
private RAG metadata:

```json
{
  "id": "sora-roll",
  "category": "Maki",
  "name": "Snowfox house roll",
  "description": "Snow crab, avocado, cucumber, tuna, toasted sesame.",
  "price": "24",
  "availability": "available",
  "allergens": ["fish", "shellfish", "wheat", "soy", "sesame"],
  "fullDishInfo": "Snow crab is delivered on Tuesday; house sauce contains wheat.",
  "image": {
    "key": "dishes/sora-roll/550e8400-e29b-41d4-a716-446655440000.webp",
    "alt": "Snowfox house roll with tuna and avocado",
    "width": 800,
    "height": 600
  }
}
```

The five core fields are required strings. The write API trims their values and
validates:

- `id`: 1-100 characters using letters, numbers, hyphens, or underscores
- `category`: 1-50 characters
- `name`: 1-120 characters
- `description`: 1-1000 characters
- `price`: a non-negative decimal string with at most two decimal places
- `availability`: `available` or `out`; values are trimmed and normalized to
  lowercase, and legacy dishes without the field default to `available`
- `allergens`: an optional unique array using this canonical order: `fish`,
  `shellfish`, `milk`, `egg`, `peanut`, `tree-nuts`, `wheat`, `soy`, and
  `sesame`. The legacy value `gluten` is accepted on writes and normalized to
  canonical `wheat`.
- `fullDishInfo`: optional private text up to 4000 characters
- `image`: optional exact object containing an S3 `key`, trimmed `alt` text up
  to 250 characters, and integer `width`/`height` values from 1-10000. The key
  must use `dishes/<same-dish-id>/<safe-name>.jpg|jpeg|png|webp`.

Unknown fields are rejected so requests and responses stay consistent with the
frontend model. Legacy dishes without `availability` or optional metadata
remain valid.

## Get the published menu

`GET /dishes` is public so the landing page can load its menu without requiring
customers to sign in. It returns the published dishes in their saved order:

```json
[
  {
    "id": "sora-roll",
    "category": "Maki",
    "name": "Snowfox house roll",
    "description": "Snow crab, avocado, cucumber, tuna, toasted sesame.",
    "price": "24",
    "availability": "available",
    "allergens": ["fish", "shellfish", "wheat", "soy", "sesame"],
    "image": {
      "key": "dishes/sora-roll/550e8400-e29b-41d4-a716-446655440000.webp",
      "alt": "Snowfox house roll with tuna and avocado",
      "width": 800,
      "height": 600
    }
  }
]
```

The public response deliberately excludes `fullDishInfo`, even when it is stored in
DynamoDB. `GET /dishes/private` requires a valid Cognito admin token and returns
the full records for the menu editor, preventing private notes from appearing in
browser network responses for public visitors.

Before the first whole-menu save, the read Lambda also supports legacy
individual dish rows. It follows every DynamoDB Scan page and sorts those rows
by `id`. After a whole-menu save, it reads the atomic `MENU#CURRENT` document.

## Replace the complete menu

`PUT /dishes` matches the frontend editor's save behavior. It accepts an object
containing 1-50 dishes and requires a valid Cognito ID token whose user belongs
to the configured admin group:

```json
{
  "items": [
    {
      "id": "sora-roll",
      "category": "Maki",
      "name": "Snowfox house roll",
      "description": "Snow crab, avocado, cucumber, tuna, toasted sesame.",
      "price": "24",
      "availability": "available",
      "allergens": ["fish", "shellfish", "wheat", "soy", "sesame"],
      "fullDishInfo": "Snow crab is delivered on Tuesday.",
      "image": {
        "key": "dishes/sora-roll/550e8400-e29b-41d4-a716-446655440000.webp",
        "alt": "Snowfox house roll with tuna and avocado",
        "width": 800,
        "height": 600
      }
    }
  ]
}
```

The Lambda validates every dish, rejects duplicate IDs, preserves array order,
and writes the menu as one DynamoDB item. A single `PutItem` means additions,
updates, removals, and ordering are published together rather than partially.

A fictional 17-dish payload with private retrieval context is available at
[`../sample-data/rag-test-menu.json`](../sample-data/rag-test-menu.json). See
[`../sample-data/README.md`](../sample-data/README.md) before loading it into a
development or staging environment because `PUT /dishes` replaces the complete
menu.

## Save a dish

`POST /dishes` remains available for compatibility with individual-dish tools.
It accepts one dish and requires the same Cognito admin authorization. A new ID
returns `201 Created`; saving an existing ID replaces that legacy dish and
returns `200 OK`. The landing-page editor uses `PUT /dishes` instead.

## Upload a dish image

`POST /dish-images/upload-url` requires the same Cognito admin authorization as
menu writes. It accepts declared metadata for one JPEG, PNG, or WebP file up to
5 MiB:

```json
{
  "dishId": "sora-roll",
  "contentType": "image/webp",
  "size": 125000
}
```

The Lambda validates the request, creates an immutable server-controlled S3
key, and returns a presigned `PUT` URL that expires after five minutes:

```json
{
  "uploadUrl": "https://...signed S3 URL...",
  "key": "dishes/sora-roll/550e8400-e29b-41d4-a716-446655440000.webp",
  "expiresIn": 300,
  "uploadHeaders": {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": "image/webp"
  }
}
```

The browser uploads the image bytes directly to `uploadUrl` using the exact
returned headers, then includes the returned key plus the image's alt text and
dimensions in `PUT /dishes`. The signed immutable cache header lets browsers
reuse unchanged images efficiently. API Gateway and Lambda never carry the
image bytes. Only newly selected files are uploaded; unchanged image keys are
saved as metadata without re-uploading their S3 objects.

The application-hosting CloudFront distribution serves only the React build;
it does not proxy dish images. `dish_images_public_read_enabled = true` permits
public `GetObject` only under the image bucket's `dishes/` prefix, while upload
and delete permissions remain private. A later, separate dish-image CloudFront
migration can add Origin Access Control, set this variable to `false`, and
change `VITE_DISH_IMAGES_BASE_URL` without moving existing objects or changing
stored DynamoDB keys.

## Restaurant announcements

Announcements are stored in the encrypted restaurant-content table. The table
uses `pk` and `sk` keys so opening hours or other restaurant-managed content can
be added later without mixing that data into the menu or Orders tables. An
announcement item uses `RESTAURANT#SORA` as its partition key and
`ANNOUNCEMENT#<announcementId>` as its sort key.
`RESTAURANT#SORA` is a stable internal storage key retained for compatibility;
it does not control the customer-facing Snowfox name.

`GET /announcements` is public. It returns only `PUBLISHED` announcements for
which `startsAt <= current server time < endsAt`, ordered by descending priority
and then newest start time. Drafts, expired announcements, future scheduled
announcements, internal DynamoDB keys, and administrator IDs are not returned.

`GET /announcements/private` requires an administrator Cognito token and returns
the complete announcement list for the editor. Administrators create notices
with `POST /announcements`, and update or delete one notice with
`PATCH /announcements/{announcementId}` or
`DELETE /announcements/{announcementId}`. The server generates IDs and audit
timestamps; the browser cannot select them.

A create request has this shape:

```json
{
  "type": "DISCOUNT",
  "title": "Weekday lunch special",
  "message": "Show code LUNCH10 when collecting your order.",
  "promoCode": "LUNCH10",
  "status": "PUBLISHED",
  "startsAt": "2030-07-23T18:00:00.000Z",
  "endsAt": "2030-07-31T03:00:00.000Z",
  "priority": 50
}
```

Allowed types are `GENERAL`, `DISCOUNT`, `CLOSURE`, and `EVENT`; status is
`DRAFT` or `PUBLISHED`; and priority is an integer from 0 through 100. Title,
message, time-window, promo-code, and exact-field validation is enforced by the
Lambda. A promo code is allowed only for a discount announcement.

Updates send the full editable announcement plus the `updatedAt` value last
read from the private endpoint as `expectedUpdatedAt`. Deletes send
`{"expectedUpdatedAt":"..."}`. DynamoDB conditional writes return `409` when
another administrator changed or deleted the same notice first, so one browser
does not silently overwrite a newer edit.

Promo codes in announcements are display-only. They do not change menu prices
or order totals. Redeemable discounts would require separate server-side
promotion validation and authoritative price calculation in the create-order
Lambda.

## Create a pickup order

`POST /orders` requires a valid Cognito ID token from any signed-in customer.
It accepts the frontend's pickup-order request:

```json
{
  "clientRequestId": "order-550e8400-e29b-41d4-a716-446655440000",
  "items": [
    { "dishId": "sora-roll", "quantity": 2 }
  ],
  "fulfillment": "pickup",
  "pickupContact": {
    "name": "Sithu Lin",
    "phoneNumber": "+14155552671"
  },
  "customerNote": "Please include chopsticks."
}
```

The create-order Lambda does not trust browser prices or availability. It reads
the published `MENU#CURRENT` item consistently, rejects missing or `out`
dishes, and calculates integer-cent prices from the stored menu. It derives the
customer ID from the Cognito token and stores a snapshot of each dish's current
name and price in a separate Orders table.

The Lambda creates the order and an idempotency marker in one DynamoDB
transaction. The marker combines the Cognito customer ID with
`clientRequestId`. Repeating the same request returns the original order;
reusing the ID for different contents returns `409 IDEMPOTENCY_CONFLICT`.
A real order also stores a `customerOrderKey` derived from the authenticated
Cognito `sub`. Idempotency markers do not have that attribute, so they cannot
appear in customer-history queries.
A successful create returns:

```json
{
  "orderId": "ord_550e8400-e29b-41d4-a716-446655440001",
  "status": "PENDING",
  "notificationStatus": "PENDING",
  "fulfillment": "pickup",
  "currency": "USD",
  "itemCount": 2,
  "subtotalCents": 4800,
  "totalCents": 4800,
  "createdAt": "2026-07-22T20:15:00.000Z"
}
```

`status` represents the restaurant workflow. Email delivery never changes it.
`notificationStatus` is updated separately after SES accepts the admin email.

### List pickup orders for administrators

`GET /orders` uses the same API Gateway resource as customer order creation, but
requires both a valid Cognito ID token and membership in the configured admin
group. It queries the Orders-table `entityType-createdAt-index` newest first.
The optional `limit` query parameter defaults to 25 and is capped at 100.
When more orders exist, pass the opaque response `nextToken` back as a query
parameter to load the next page.

The response includes the order status, notification status, pickup contact,
stored item snapshots, totals, customer note, the current restaurant-provided
`pickupTime` and `restaurantNote` when present, failed-pickup scheduling and
recording timestamps when applicable, and timestamps. Internal customer IDs,
idempotency records, request hashes, failure-table keys, administrator IDs, and
event metadata are not returned.

### Update an order's restaurant status

`PATCH /orders/{orderId}/status` requires both a valid Cognito ID token and
membership in the configured admin group. Replace `{orderId}` with the order ID
and send the requested new status, the status the administrator currently sees,
and the confirmation details:

```json
{
  "status": "CONFIRMED",
  "expectedStatus": "PENDING",
  "pickupTime": "2030-07-23T19:00:00.000Z",
  "restaurantNote": "Please arrive at the pickup counter."
}
```

`expectedStatus` provides optimistic concurrency control. The update succeeds
only if DynamoDB still contains that status, preventing one administrator from
silently overwriting a newer action from another administrator.

`pickupTime` is required when the new status is `CONFIRMED` and is not allowed
for another target status. It must be a canonical UTC ISO timestamp in the
future, such as `2030-07-23T19:00:00.000Z`. `restaurantNote` is an optional
customer-visible string of at most 500 characters. It is separate from the
customer's original `customerNote`.

A successful request returns the current restaurant status details:

```json
{
  "order": {
    "orderId": "ord_550e8400-e29b-41d4-a716-446655440001",
    "status": "CONFIRMED",
    "pickupTime": "2030-07-23T19:00:00.000Z",
    "restaurantNote": "Please arrive at the pickup counter.",
    "updatedAt": "2030-07-23T18:30:00.000Z"
  }
}
```

These are current-state fields rather than an audit log. A later status
transition removes a no-longer-applicable `pickupTime`; a new restaurant note
replaces the previous note, and an omitted or blank note removes it. DynamoDB
stores these as optional attributes, so this change needs no table or index
migration. Orders created or confirmed before the fields were introduced can
continue to exist without them.

The normal status selector allows:

- `PENDING` to `CONFIRMED`, `CANCELLED`, or `REJECTED`
- `CONFIRMED` to `CANCELLED`
- `CANCELLED` and `REJECTED` are terminal

`CONFIRMED` to `FAILED_TO_PICKUP` is available through the separate
administrator **Mark as not picked up** action after the stored pickup time has
passed. It uses the same PATCH endpoint:

```json
{
  "status": "FAILED_TO_PICKUP",
  "expectedStatus": "CONFIRMED",
  "restaurantNote": "The order was not collected before closing."
}
```

The Lambda loads the order consistently and derives `customerId` and the
scheduled pickup time from that stored order; the request cannot supply either
value. It verifies that the stored status is `CONFIRMED` and that the stored
pickup time is not later than the server time. It then uses one DynamoDB
transaction to:

1. set the order to `FAILED_TO_PICKUP`, move the active `pickupTime` to
   `scheduledPickupTime`, record `failedToPickupAt`, and retain the
   administrator ID internally for auditing;
2. increment the customer's `SUMMARY` count while preserving whichever failure
   is actually the newest; and
3. add one immutable `FAILURE#<time>#<orderId>` history record containing the
   order ID, scheduled and recorded times, and the administrator ID internally.

The transaction updates both DynamoDB tables completely or not at all. A
conditional order update and exact-retry recovery prevent concurrent requests
or a lost response from incrementing the count twice. A conditional summary
update also prevents concurrent failures for the same customer from moving the
stored most-recent failure backward. `FAILED_TO_PICKUP` is terminal and has no
outgoing transitions.

A missing order returns `404`. A stale `expectedStatus` returns `409` when the
stored status differs from the requested status. Retrying an update that already
reached the requested status with the same pickup time and restaurant note
returns the current order as `200`, making exact retries idempotent. A retry
whose status matches but whose details differ returns `409`. Invalid status,
pickup-time, or note data, or a disallowed transition, returns `422` without
changing the order. Every successful new status transition is captured by the
Orders stream for asynchronous customer email. An exact retry that performs no
new DynamoDB update creates no new stream event.

For a `CONFIRMED` request whose pickup time has already passed, the API first
performs a consistent retry check. It returns `200` only for an exact stored
confirmation; every other past-time request returns `422` and cannot update the
order. This preserves exact lost-response retries without allowing a new
confirmation to be scheduled in the past.

### List pickup orders for the signed-in customer

`GET /orders/mine` requires a valid Cognito ID token. The Lambda derives the
customer ID exclusively from the token's `sub` claim; the request cannot supply
or override a customer ID. It queries the Orders-table
`customerOrderKey-createdAt-index` newest first, so one customer cannot read
another customer's orders.

The optional `limit` query parameter defaults to 20 and is capped at 50. Pass
the opaque response `nextToken` back as a query parameter to load another page.
The response contains order IDs, restaurant status, fulfillment, stored item
snapshots, pickup contact details, totals, customer notes, the current
restaurant-provided `pickupTime` and `restaurantNote` when present, and
timestamps. A failed-pickup order instead includes its original
`scheduledPickupTime` and the server-controlled `failedToPickupAt`. The
restaurant note is intentionally customer-visible. The response excludes
internal customer and administrator IDs, idempotency data, request hashes,
event metadata, and administrator email-notification state.

The customer index is sparse: only records containing `customerOrderKey` are
included. Orders created before this field was introduced require a one-time
backfill if they should appear in history. After deploying the index, run this
from `Backend/terraform/lambda` in PowerShell:

```powershell
$env:AWS_PROFILE = "portfolioproject1forjob"
$env:AWS_REGION = "us-east-1"
$env:ORDERS_TABLE = terraform -chdir=.. output -raw orders_table_name
npm run backfill:customer-orders
```

The backfill is conditional and safe to run again. It updates only real orders
that are missing the key and prints aggregate counts without customer IDs.

### Read a customer's failed-pickup history as an administrator

`GET /admin/orders/{orderId}/customer/pickup-failures` requires a valid
Cognito ID token and membership in the configured admin group. The browser
supplies only an order ID. The Lambda loads that order, derives the stored
customer ID internally, strongly queries `FAILURE#` records newest first, and
then reads the customer's `SUMMARY` item consistently.

The optional `limit` query parameter defaults to 20 and is capped at 50. Use
the opaque `nextToken` to load another history page. A response has this shape:

```json
{
  "failedPickupCount": 2,
  "lastFailedPickupAt": "2030-07-23T21:00:00.000Z",
  "lastFailedOrderId": "ord_550e8400-e29b-41d4-a716-446655440001",
  "failures": [
    {
      "orderId": "ord_550e8400-e29b-41d4-a716-446655440001",
      "scheduledPickupTime": "2030-07-23T19:00:00.000Z",
      "failedPickupAt": "2030-07-23T21:00:00.000Z"
    }
  ],
  "nextToken": null
}
```

The response deliberately omits the Cognito customer ID and the administrator
who recorded each failure. Existing legacy `FAILED_TO_PICKUP` orders are still
readable as orders but are not automatically inserted into the new summary or
history table; counting them requires an explicit backfill.

### New-order administrator notification pipeline

The Orders table stream uses `NEW_AND_OLD_IMAGES`. The existing new-order
EventBridge Pipe filters for inserted records whose `entityType` is `ORDER`,
excluding idempotency markers and later status updates. It sends only this small
message to SQS, so customer contact information is not copied into the queue:

```json
{
  "eventType": "ORDER_CREATED",
  "version": 1,
  "orderId": "ord_550e8400-e29b-41d4-a716-446655440001"
}
```

The notify-order Lambda loads the order from DynamoDB, sends escaped plain-text
and HTML email through SES, and marks the notification `SENT`. SQS invokes it
with partial-batch failure reporting. A failed message is retried and moves to
the encrypted dead-letter queue after five receives; successful messages in
the same batch are not retried.

Set `ses_sender_email` and `admin_order_email` in the environment's `.tfvars`
file before planning. The sender must be a verified SES identity in the same
AWS Region. While SES is in the sandbox, every recipient must also be verified:
that includes the administrator and each customer address used for a status
email. Request SES production access before sending status email to arbitrary
registered customers. Terraform configures the Lambdas and their
least-privilege send permissions but does not verify SES identities or request
production access.

### Customer status email pipeline

A second EventBridge Pipe reads the same Orders stream and selects `MODIFY`
records for real orders whose new status is `CONFIRMED`, `CANCELLED`,
`REJECTED`, or `FAILED_TO_PICKUP`. It sends a minimal event to a separate
encrypted SQS queue:

```json
{
  "eventType": "ORDER_STATUS_CHANGED",
  "version": 1,
  "eventId": "dynamodb-stream-event-id",
  "orderId": "ord_550e8400-e29b-41d4-a716-446655440001",
  "previousStatus": "PENDING",
  "status": "CONFIRMED",
  "changedAt": "2030-07-23T18:30:00.000Z"
}
```

The message deliberately excludes the customer's email, phone number, name,
items, and notes. The customer-status Lambda validates the exact event shape,
loads the order consistently, and obtains the recipient exclusively from the
stored `customerEmail`. It sends escaped plain-text and HTML email through SES.
Confirmation email includes the stored pickup time; failed-pickup email uses
the stored scheduled and failure times. Cancellation and rejection email may
include the current restaurant message. The email is an order-time snapshot;
changing a Cognito account's email later does not change older orders.

The Lambda sends only when the stored `status` and `statusUpdatedAt` still match
the queued event. If a later transition has already reached DynamoDB, the older
event is acknowledged without sending an obsolete email. Non-status
modifications whose old and new status are equal are also ignored.

This pipeline intentionally does not create notification records or otherwise
write to DynamoDB. The Standard SQS queue and Lambda integration provide
at-least-once processing, so a customer can occasionally receive a duplicate
email—for example, if SES accepts a message but Lambda fails before SQS
acknowledgement. Processing failures are retried and move to the dedicated
encrypted dead-letter queue after five receives. Partial-batch reporting keeps
successful records in the same Lambda batch from being retried.

No `PICKED_UP` status or pickup-completion button is part of this pipeline.
The new-order and status-change Pipes are the two direct consumers of the
Orders stream. Fan out downstream rather than adding another direct stream
consumer if a third order-event workflow is needed later.

## DynamoDB change stream

The dishes table has DynamoDB Streams enabled with `NEW_AND_OLD_IMAGES`. Every
insert, update, or removal triggers the dedicated `dish-stream` Lambda. It
unmarshals the DynamoDB values and compares old and new dishes. CloudWatch
receives metadata only:

- the event type (`INSERT`, `MODIFY`, or `REMOVE`)
- the changed item key
- the changed field names
- the stream event and sequence identifiers

Because the frontend stores the published menu as the aggregate
`MENU#CURRENT` record, the stream handler compares the old and new `items`
arrays by dish ID. It emits one log for each added, removed, or field-modified
dish instead of logging the complete menu. Private `fullDishInfo` and complete
dish records are deliberately excluded from logs.

Allergen, `fullDishInfo`, availability, image, and other dish changes enqueue a
minimal refresh request in the encrypted FIFO dish-index queue. The message
contains a dish ID and stream metadata, but no dish content:

```json
{"eventType":"DISH_INDEX_REFRESH_REQUESTED","version":1,"eventName":"MODIFY","dishId":"sora-roll"}
```

The Python indexer consumes the queue and consistently reloads
`MENU#CURRENT`. If the dish currently exists, it replaces that dish's
deterministic Weaviate chunks; otherwise it deletes the dish's chunks. Loading
the current record makes duplicate or delayed queue messages converge on the
same authoritative state. Failures retry and move to the encrypted FIFO DLQ
after five receives. Successful records in the same batch are acknowledged
with Lambda partial-batch reporting. The stream publisher batches up to ten SQS
entries per API call. The indexer consumes one queue record per invocation and
is capped at two concurrent invocations to avoid a burst of external API calls.

When an image key is replaced or removed, the stream Lambda also deletes the
obsolete S3 key only after the DynamoDB menu update has succeeded. Image cleanup
and vector refresh are independent idempotent side effects of the same
per-dish comparison. Bulk obsolete keys use one S3 multi-object delete request.

The event source starts at `TRIM_HORIZON`, so it processes every change retained
by the new stream while the trigger is being created. Enabling the stream does
not generate events for items that were already stored before it was enabled.

## RAG chat

Authenticated customers create a server-owned session with
`POST /chat/sessions`, load their owned session with
`GET /chat/sessions/{chatId}`, and send a message with
`POST /chat/sessions/{chatId}/messages`. The chat ID is a server-generated UUID.
Every operation compares the session's stored owner with the Cognito `sub`
claim; a caller-supplied user ID is never trusted.

The new encrypted chat-history DynamoDB table stores one `META` ownership item,
message items, and idempotency records under `PK = CHAT#<chatId>`. DynamoDB TTL
removes the session and its history after the configured retention period. The
repository also rejects an expired session immediately instead of waiting for
DynamoDB's asynchronous physical deletion.

For each question, the chat Lambda performs hybrid Weaviate retrieval. Cohere
then reranks each candidate against one composite `rerank_text` value containing
the dish name, category, description, price, allergens, availability, and that
candidate's `fullDishInfo` chunk. The composite is stored only for reranking; it
is excluded from OpenAI vectorization and keyword indexing so the first-stage
hybrid candidate search remains unchanged.

The Lambda takes the highest-ranked dish IDs and then consistently reloads the
complete current dishes from DynamoDB. Deleted candidates are discarded, and
current `availability`, allergens, prices, and `fullDishInfo` come from
DynamoDB—not from possibly stale vector metadata. OpenAI generates the answer
from those authoritative records. The public API returns the answer and message
metadata only; it never returns the retrieved chunks or private menu context.
Weaviate and OpenAI each have a nine-second request timeout so the Lambda can
return a sanitized error before API Gateway's request window expires. The
cost-bearing message method also has an aggregate API Gateway throttle target;
this is burst protection, not a billing quota.

For short-lived staging diagnostics, enable any of these independent settings:

- `rag_log_retrieved_candidates` writes `RAG_RETRIEVED_CANDIDATES`, exposing
  every parsed Weaviate candidate with its response rank, dish ID, chunk index,
  rerank score, selection result, rejection reason, and at most 500 characters
  of chunk text. Reasons distinguish a score below the minimum, invalid or
  stale dish IDs, duplicate dishes, and candidates after the context limit.
- `rag_log_selected_chunks` writes `RAG_SELECTED_CHUNKS` with only the
  qualifying unique chunk for each selected dish.
- `rag_log_openai_context_dishes` writes `OPENAI_CONTEXT_DISHES` with the exact
  current DynamoDB fields supplied to OpenAI: ID, category, name, description,
  price, allergens, `fullDishInfo`, and availability. Its `openaiRequestSent`
  field is false when no dish qualifies and OpenAI is skipped.
- `rag_log_user_questions` adds the exact validated `question` to every enabled
  event above, making events from concurrent requests distinguishable. It has no
  effect unless at least one of the other diagnostic settings is enabled.

Without `rag_log_user_questions`, these events omit the question. They always
omit chat history, customer identity, request ID, OpenAI answer, image metadata,
credential fields, and unrecognized candidate fields. Questions can contain
personal or sensitive information, so production plans reject all four
settings. Disable them and reapply after debugging; the existing CloudWatch
retention policy still applies to events already stored.

```powershell
aws logs tail "/aws/lambda/sushi-menu-api-staging-rag-chat" `
  --since 10m `
  --follow `
  --filter-pattern 'RAG_RETRIEVED_CANDIDATES' `
  --region us-east-1
```

See [`../RAG-ARCHITECTURE.md`](../RAG-ARCHITECTURE.md) for the complete flow,
failure behavior, and operations guide.

## What it creates

- DynamoDB table `dishes-table-<stage>`, keyed by the frontend's `id`
- Separate encrypted Orders table with point-in-time recovery, newest-first
  admin and per-customer listing indexes, and a `NEW_AND_OLD_IMAGES` stream
- Separate encrypted customer pickup-failure table with point-in-time recovery,
  one per-customer summary item, and one immutable item per recorded failure
- Separate encrypted restaurant-content table with point-in-time recovery for
  scheduled announcements and future restaurant-managed content
- Separate encrypted chat ownership/history table with TTL and point-in-time
  recovery
- Separate encrypted SQS queues and dead-letter queues for new-order
  administrator notifications, customer status notifications, and FIFO
  per-dish vector-index refreshes
- Two EventBridge Pipes: one sends newly inserted order IDs to the administrator
  notification queue, and one sends minimal status-change events to the customer
  notification queue
- Versioned, encrypted S3 bucket for dish images with browser upload CORS and
  public reads limited to `dishes/` until CloudFront is enabled
- Separate private, versioned S3 bucket for the React production build in the
  `default-staging` and `default-prod` workspaces
- CloudFront distribution with Origin Access Control, HTTPS-only delivery,
  security headers, uncached application-shell files, and long-lived caching
  for Vite's fingerprinted `assets/*`
- ACM certificate and Route 53 A/AAAA aliases for
  `www.staging.snowfoxcorvallis.com` or `www.snowfoxcorvallis.com`
- Cognito user pool with verified-email password recovery, app client, and
  `admin` group
- Node.js 22 Lambdas for reading, validating, saving, replacing, preparing image
  uploads, creating orders, listing admin or customer order history, updating
  restaurant order status, reading customer pickup-failure history for admins,
  reading and managing announcements, emailing new-order and customer status
  notifications, logging dish changes, and removing obsolete images
- Dependency-light Python 3.13 Lambdas for Weaviate index reconciliation and
  authenticated RAG chat
- API Gateway REST endpoints: public `GET /dishes`, admin
  `GET /dishes/private`, admin `POST/PUT /dishes`, and admin
  `POST /dish-images/upload-url`, plus customer `POST /orders`, admin
  `GET /orders`, authenticated-customer `GET /orders/mine`, and admin
  `PATCH /orders/{orderId}/status` and
  `GET /admin/orders/{orderId}/customer/pickup-failures`, plus public
  `GET /announcements` and admin `GET /announcements/private`,
  `POST /announcements`, and `PATCH/DELETE /announcements/{announcementId}`,
  plus authenticated chat-session and message routes under `/chat/sessions`
- CORS preflight and CORS headers on API/Lambda errors
- Separate least-privilege IAM roles for DynamoDB reads/writes and scoped S3
  uploads/deletes under `dishes/`
- DynamoDB stream trigger with scoped obsolete-image deletion and dish-index
  queue publishing

## Install and test

From this Terraform folder:

```bash
cd lambda
npm ci
npm test
cd ..
python -m unittest discover -s lambda-rag/tests -t lambda-rag -v
```

Terraform packages the complete `lambda` folder, including its installed
dependencies, into `build/lambda-source.zip`. The Python RAG code uses the
standard library plus the `boto3` included in the Lambda runtime, so Terraform
can package `lambda-rag` separately without Linux-native dependency builds.

## Deploy staging, then production

The selected Terraform workspace is the source of truth for both the AWS
account and deployment stage. This is important: changing a stage variable in
one state would rename or replace that environment instead of creating a second
one. The project therefore uses independent workspaces and state for `dev`,
`staging`, and `prod`.

For AWS account `058264296908`, initialize Terraform and prepare the staging
settings in PowerShell. Do not overwrite an existing `staging.tfvars`:

```powershell
$env:TF_VAR_frontend_root_domain_name = "snowfoxcorvallis.com"
terraform init
# First deployment only, when staging.tfvars does not exist:
# Copy-Item staging.tfvars.example staging.tfvars
```

Terraform uses that standard `TF_VAR_` environment variable to find the public
Route 53 hosted zone by name; the hosted-zone ID is not stored in the
configuration. The workspace supplies `www.staging` or `www`, which Terraform
combines with the root domain. Set the variable again in each new terminal
session before running `plan`.

The staging CORS origin must be
`https://www.staging.snowfoxcorvallis.com`. Create the staging workspace the
first time, or select it on later deployments:

```powershell
terraform workspace new default-staging
# Later deployments use:
# terraform workspace select default-staging
terraform workspace show

terraform plan `
  -var-file=staging.tfvars `
  -out=staging.tfplan
terraform apply staging.tfplan
```

If `rag_credentials_secret_arn` was left empty, the apply creates an empty
secret container and prints its ARN:

```powershell
terraform output -raw rag_credentials_secret_arn
```

Open that secret in AWS Secrets Manager and store one JSON value:

```json
{
  "OPENAI_API_KEY": "<new-key>",
  "WEAVIATE_API_KEY": "<new-key>",
  "COHERE_API_KEY": "<new-key>",
  "WEAVIATE_URL": "https://your-cluster.weaviate.network"
}
```

`WEAVIATE_URL` is needed in the secret only when `rag_weaviate_url` is empty.
Do not put these values in Terraform, `.tfvars`, frontend variables, Lambda
environment variables, source files, or logs. Updating the secret value later
does not require another Terraform apply; warm Lambda environments refresh
their cached credentials after five minutes. If
`rag_credentials_kms_key_arn` is set and Terraform creates the secret, that
customer-managed key is attached to the secret as well as granted narrowly to
the Lambda roles. An externally supplied secret must already use that key, and
its key policy must allow the roles to decrypt it.

The stream cannot replay menu changes older than DynamoDB Streams retention.
After storing the secret, run the `rag-indexer` Lambda once from the Lambda
console with this test event:

```json
{"rebuild": true}
```

The rebuild loads the complete authoritative menu, replaces only the current
stage's Weaviate collection, and creates deterministic chunk IDs. Normal
admin menu saves are incremental after that.

The `rerank_text` schema is not upgraded incrementally. After deploying a code
version that introduces this field, immediately run the same full rebuild once.
Until the rebuild finishes, chat rejects the legacy collection so it cannot
silently mix objects with and without the composite Cohere context.

The first frontend-hosting apply requests and DNS-validates an ACM certificate,
creates an empty private S3 bucket, deploys CloudFront, and creates the custom
domain records. CloudFront provisioning can take several minutes. The site may
return `403` until the React build is uploaded.

Test the staging API and frontend before creating production. Production uses a
separate workspace, domain, and variable file:

```powershell
$env:TF_VAR_frontend_root_domain_name = "snowfoxcorvallis.com"
Copy-Item prod.tfvars.example prod.tfvars
terraform workspace new default-prod
# Later deployments use:
# terraform workspace select default-prod
terraform workspace show

terraform plan `
  -var-file=prod.tfvars `
  -out=prod.tfplan
terraform apply prod.tfplan
```

Never run production from `default-staging`, and do not reuse the `default` dev
workspace for either environment. The workspace mapping in `versions.tf`
prevents a workspace from changing its account or stage. The alternate
`account-6528-*` workspaces target account `971431176528` and intentionally do
not own the `snowfoxcorvallis.com` frontend aliases.

The environments receive different API Gateway URLs, Cognito pools and clients,
DynamoDB tables, Lambdas, IAM roles, and CloudWatch log groups. Menu data,
Cognito users, and admin-group membership are not copied from staging to
production automatically.

Useful deployment values:

```bash
terraform output deployment_stage
terraform output terraform_workspace
terraform output resource_name_prefix
terraform output get_dishes_url
terraform output get_private_dishes_url
terraform output create_dish_url
terraform output replace_dishes_url
terraform output dish_image_upload_url
terraform output create_order_url
terraform output list_orders_url
terraform output list_my_orders_url
terraform output update_order_status_url
terraform output get_customer_pickup_failures_url
terraform output public_announcements_url
terraform output admin_announcements_url
terraform output admin_announcement_url
terraform output dish_images_bucket_name
terraform output dish_images_base_url
terraform output frontend_bucket_name
terraform output frontend_cloudfront_distribution_id
terraform output frontend_cloudfront_domain_name
terraform output frontend_url
terraform output orders_table_name
terraform output customer_pickup_failures_table_name
terraform output restaurant_content_table_name
terraform output orders_list_index_name
terraform output customer_orders_index_name
terraform output order_notifications_queue_url
terraform output order_notifications_dlq_url
terraform output customer_status_notifications_queue_url
terraform output customer_status_notifications_dlq_url
terraform output order_created_pipe_name
terraform output order_status_changed_pipe_name
terraform output notify_customer_status_lambda_name
terraform output notify_customer_status_log_group_name
terraform output update_order_status_lambda_name
terraform output update_order_status_log_group_name
terraform output get_customer_pickup_failures_lambda_name
terraform output get_customer_pickup_failures_log_group_name
terraform output get_announcements_lambda_name
terraform output get_announcements_log_group_name
terraform output manage_announcements_lambda_name
terraform output manage_announcements_log_group_name
terraform output dynamodb_stream_arn
terraform output dish_stream_lambda_name
terraform output dish_stream_log_group_name
terraform output rag_credentials_secret_arn
terraform output rag_collection_name
terraform output dish_index_updates_queue_url
terraform output dish_index_updates_dlq_url
terraform output rag_indexer_lambda_name
terraform output rag_chat_lambda_name
terraform output chat_history_table_name
terraform output create_chat_session_url
terraform output get_chat_session_url
terraform output send_chat_message_url
terraform output cognito_user_pool_id
terraform output cognito_user_pool_client_id
terraform output cognito_admin_group_name
terraform output -json frontend_environment
```

Load all dishes without an authorization header:

```bash
curl "$(terraform output -raw get_dishes_url)"
```

Load the full menu editor data with an admin ID token:

```bash
curl "$(terraform output -raw get_private_dishes_url)" \
  -H "Authorization: <COGNITO_ID_TOKEN>"
```

## Deploy the React frontend

Build staging with the outputs from `default-staging`, and production with the
outputs from `default-prod`. The `frontend_environment` output provides
`VITE_API_BASE_URL`, `VITE_COGNITO_USER_POOL_ID`,
`VITE_COGNITO_CLIENT_ID`, `VITE_COGNITO_ADMIN_GROUP`, and
`VITE_DISH_IMAGES_BASE_URL` together. Vite embeds these public configuration
values at build time, so verify `.env.local` contains the outputs for the
selected workspace before building.

After the frontend-hosting Terraform apply completes, run these commands from
this Terraform folder in PowerShell:

```powershell
terraform workspace show
$frontendBucket = terraform output -raw frontend_bucket_name

Push-Location ..\..\Frontend
npm ci
npm test
npm run lint
npm run build

# Upload fingerprinted files first. Keep older hashed files temporarily so a
# cached older index.html can still load during the deployment window.
aws s3 sync .\dist\assets "s3://$frontendBucket/assets" `
  --cache-control "public,max-age=31536000,immutable"

# Upload the application shell last. Excluded assets are not deleted.
aws s3 sync .\dist "s3://$frontendBucket" `
  --delete `
  --exclude "assets/*" `
  --cache-control "no-cache,no-store,must-revalidate"
Pop-Location
```

The default CloudFront behavior uses AWS's managed disabled-cache policy, so a
normal deployment does not require an invalidation. If the policy is changed
later, invalidate `/` and `/index.html` using
`frontend_cloudfront_distribution_id`. Direct S3 object requests should remain
denied; test the site through `terraform output -raw frontend_url`.

The frontend derives the order, announcement, and chat endpoints from
`VITE_API_BASE_URL`. The application-hosting distribution does not proxy the
API and does not change `VITE_DISH_IMAGES_BASE_URL`.

Load the currently active public announcements:

```bash
curl "$(terraform output -raw public_announcements_url)"
```

Create an announcement with an admin Cognito ID token:

```bash
curl -X POST "$(terraform output -raw public_announcements_url)" \
  -H "Authorization: <ADMIN_COGNITO_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"type":"DISCOUNT","title":"Weekday lunch special","message":"Show code LUNCH10 when collecting your order.","promoCode":"LUNCH10","status":"PUBLISHED","startsAt":"2030-07-23T18:00:00.000Z","endsAt":"2030-07-31T03:00:00.000Z","priority":50}'
```

Create a pickup order with any authenticated customer ID token:

```bash
curl -X POST "$(terraform output -raw create_order_url)" \
  -H "Authorization: <COGNITO_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"clientRequestId":"order-550e8400-e29b-41d4-a716-446655440000","items":[{"dishId":"sora-roll","quantity":2}],"fulfillment":"pickup","pickupContact":{"name":"Sithu Lin","phoneNumber":"+14155552671"},"customerNote":""}'
```

List the newest pickup orders with an admin Cognito ID token:

```bash
curl "$(terraform output -raw list_orders_url)?limit=25" \
  -H "Authorization: <ADMIN_COGNITO_ID_TOKEN>"
```

List the signed-in customer's newest pickup orders:

```bash
curl "$(terraform output -raw list_my_orders_url)?limit=20" \
  -H "Authorization: <CUSTOMER_COGNITO_ID_TOKEN>"
```

Confirm a pending order with an admin Cognito ID token:

```bash
curl -X PATCH "$(terraform output -raw api_base_url)/orders/ord_550e8400-e29b-41d4-a716-446655440001/status" \
  -H "Authorization: <ADMIN_COGNITO_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"status":"CONFIRMED","expectedStatus":"PENDING","pickupTime":"2030-07-23T19:00:00.000Z","restaurantNote":"Please arrive at the pickup counter."}'
```

After creating a Cognito user, add the user to the group printed by
`cognito_admin_group_name`. Save a dish by sending the Cognito ID token directly
in the `Authorization` header:

```bash
curl -X POST "$(terraform output -raw create_dish_url)" \
  -H "Authorization: <COGNITO_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"id":"sora-roll","category":"Maki","name":"Snowfox house roll","description":"Snow crab, avocado, cucumber, tuna, toasted sesame.","price":"24","availability":"available"}'
```

Publish the complete menu with the same ID token:

```bash
curl -X PUT "$(terraform output -raw replace_dishes_url)" \
  -H "Authorization: <COGNITO_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"id":"sora-roll","category":"Maki","name":"Snowfox house roll","description":"Snow crab, avocado, cucumber, tuna, toasted sesame.","price":"24","availability":"available"}]}'
```

After applying the stream configuration, make a menu change and view the old
and new items in the Lambda's CloudWatch log group. With the AWS CLI:

```bash
aws logs tail "$(terraform output -raw dish_stream_log_group_name)" --follow
```

## Terraform state

For GitHub Actions deployments and the required remote-state migration, see
the [GitHub Actions setup guide](../../.github/GitHubActions.md).

This project currently uses local Terraform state. Each workspace has its own
state, so staging and production can coexist:

| AWS account | Dev workspace | Staging workspace | Production workspace |
| --- | --- | --- | --- |
| `058264296908` | `default` | `default-staging` | `default-prod` |
| `971431176528` | `account-6528` | `account-6528-staging` | `account-6528-prod` |

The second account uses the local CLI profile `portfolioproject1forjob` when it
is supplied through `aws_profile`. The deployment-target mapping and provider
account guard are defined in `versions.tf`; an unlisted workspace or credentials
for the wrong account cause planning to fail.

Back up the state before changes, and move it to a protected remote backend with
locking before a shared or production workflow. Local state files are ignored
and should not be committed. Always select the intended workspace, confirm
it with `terraform workspace show`, and review a saved plan before applying.
