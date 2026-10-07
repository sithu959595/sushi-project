# Menu RAG architecture

## Outcome

The published DynamoDB menu remains the source of truth. Weaviate is a
rebuildable retrieval index, not an authoritative menu database. The browser
never receives API keys, `fullDishInfo`, retrieved chunks, or another user's
chat history.

## Incremental indexing flow

```text
Admin PUT /dishes
        |
        v
DynamoDB MENU#CURRENT
  stream: NEW_AND_OLD_IMAGES
        |
        v
dish-stream Lambda
  - compares old/new items by dish ID
  - deletes a replaced S3 image key
  - emits metadata-only logs
  - sends one minimal refresh request
        |
        v
encrypted FIFO SQS queue ----> encrypted FIFO DLQ after 5 failures
        |
        v
rag-indexer Lambda
  - rereads MENU#CURRENT consistently
  - current dish exists: replace its deterministic chunks
  - current dish absent: delete its chunks
        |
        v
stage-specific Weaviate collection
  - OpenAI text vectorization
  - Cohere reranking
```

The queue message contains only:

```json
{
  "eventType": "DISH_INDEX_REFRESH_REQUESTED",
  "version": 1,
  "eventId": "<DynamoDB stream event ID>",
  "eventName": "MODIFY",
  "sequenceNumber": "<stream sequence>",
  "dishId": "sora-roll"
}
```

It does not contain an old image, a new image, `fullDishInfo`, allergens, API
keys, or the aggregate menu.

The stream Lambda performs the per-dish comparison because DynamoDB Streams
delivers the old and new aggregate `MENU#CURRENT` item. Sending the raw stream
record directly to SQS would move that comparison downstream and place the
complete private menu in the queue.

The FIFO message group is the dish ID, so one dish is not updated concurrently.
The consumer nevertheless reloads current DynamoDB state on every delivery.
Duplicates, retries, or a delayed event therefore converge on the same current
dish rather than replaying stale message content. Bulk menu changes are sent in
SQS batches of at most ten. The SQS consumer receives one record per invocation
and runs at no more than two concurrent invocations, preventing a 50-dish save
from becoming a burst of external API calls.

## Initial rebuild

Enabling a DynamoDB Stream does not emit records for data already stored before
the stream checkpoint. After deployment and secret setup, invoke the
`rag-indexer` Lambda once with:

```json
{"rebuild": true}
```

The indexer validates and chunks the current menu before replacing the
stage-specific collection. Staging and production use different collection
names. Normal menu changes are incremental afterward.

## Chat flow

```text
Signed-in browser
  POST /chat/sessions
        |
        v
rag-chat Lambda creates UUID
        |
        v
DynamoDB chat table
  PK = CHAT#<chatId>, SK = META
  ownerSub = Cognito sub

Signed-in browser
  POST /chat/sessions/{chatId}/messages
        |
        v
1. Check META ownerSub against Cognito sub
2. Return a completed requestId result when this is a retry
3. Hybrid-search and Cohere-rerank Weaviate chunks
4. Keep the highest-ranked dish IDs
5. Consistently reload MENU#CURRENT from DynamoDB
6. Discard deleted candidates and use current full dish records
7. Ask OpenAI to answer only from that context
8. Transactionally save user message, assistant message, and request record
        |
        v
Return message metadata and answer
```

The server creates the chat ID. A browser-generated `requestId` is used only to
make message submission idempotent. Every read or write checks the Cognito
`sub` stored on the session. The table's TTL removes metadata, messages, and
request records after the configured retention period. Expiry is also enforced
on reads immediately, without waiting for DynamoDB's asynchronous TTL cleanup.

The dishes table—not a new table—is authoritative for current availability,
allergens, prices, and private full-dish context. The only new DynamoDB table is
for chat ownership and history.

## Retrieval and grounding

The indexer adapts the prototype logic from
`C:\Users\sithu\Desktop\Projects\RAG`:

- deterministic word chunks are made from `fullDishInfo`; a dish with no
  `fullDishInfo` has no vector objects
- each object includes the original chunk, dish ID, name, category,
  description, price, allergens, availability, and chunk index
- each object also stores a bounded `rerank_text` made from the name, category,
  description, price, allergens, availability, and that object's chunk
- Weaviate uses `text2vec-openai`
- hybrid retrieval combines vector and keyword search over the original
  searchable fields; `rerank_text` is excluded from this first-stage search
- Weaviate's Cohere integration reranks each candidate using `rerank_text`, so
  Cohere considers both the private chunk and the structured menu fields
- OpenAI Chat Completions generates the final grounded response

Weaviate object UUIDs are deterministic for
`<collection>:<dishId>:<chunkIndex>`. A retry cannot create random duplicate
chunks.

Adding `rerank_text` is a collection-schema migration. An existing collection
without it is rejected rather than partially upgraded because old objects would
still lack the composite value. Deploy the Lambda code and immediately perform
one full index rebuild before using chat. Incremental updates are safe again
after that rebuild.

The chat response never exposes the retrieved chunk content. Before generation,
the Lambda reloads complete records from DynamoDB so stale vector metadata
cannot override the current menu. The prompt also treats the explicit
`availability` field as current truth and does not infer an outage from phrases
such as “limited nightly” in `fullDishInfo`.

## Secrets

One Secrets Manager JSON secret supplies:

```json
{
  "OPENAI_API_KEY": "<new-key>",
  "WEAVIATE_API_KEY": "<new-key>",
  "COHERE_API_KEY": "<new-key>",
  "WEAVIATE_URL": "https://your-cluster.weaviate.network"
}
```

`WEAVIATE_URL` may instead be the nonsecret Terraform variable
`rag_weaviate_url`. Terraform stores only an existing secret ARN, or creates an
empty secret container when no ARN is supplied. It deliberately does not create
an `aws_secretsmanager_secret_version`, so API-key values never enter Terraform
configuration or state.

The Lambda roles can read only that secret ARN. If it uses a customer-managed
KMS key, set `rag_credentials_kms_key_arn` to add narrowly scoped
`kms:Decrypt`. Terraform also attaches that key when it creates the secret; an
external secret must already be configured with it and have a compatible key
policy. Credentials are cached for warm Lambda environments and are never
written to logs or responses.

## Failure behavior

- A stream comparison or SQS send failure causes DynamoDB Streams to retry the
  source record.
- S3 deletion is idempotent. Bulk obsolete keys are deleted in one request, and
  a replay can safely attempt the same deletion.
- An index update failure leaves the SQS record unacknowledged. Partial-batch
  reporting acknowledges successful records and retries failed ones.
- Five failed receives move the message to the DLQ for investigation/redrive.
- Dish replacement validates chunks before deleting old vectors. A failure
  after deletion is retried from the current DynamoDB dish.
- The message endpoint uses a transaction for both messages and its request
  record. Retrying the same `requestId` returns the stored result rather than
  appending another exchange.
- Upstream and configuration failures return sanitized API errors. Normal logs
  contain request IDs, dish IDs where needed, and error types—not credentials,
  prompts, retrieved chunks, or full dishes. Separate default-off,
  non-production diagnostics can log every retrieved candidate and its
  selection outcome, selected chunk metadata, and the exact authoritative dish
  records supplied to OpenAI. Chunk previews are limited to 500 characters.
  A separate default-off setting can attach the exact question to those events
  for correlation. These diagnostics never log history, identity, answers, or
  credential fields. Questions and menu text can still contain sensitive data;
  disable every diagnostic immediately after investigation.
- Chat gives each sequential Weaviate/OpenAI call a bounded timeout and applies
  an aggregate API Gateway throttle target to the message route. API Gateway
  throttles are best-effort burst controls, not guaranteed spending limits.

## Deployment checklist

1. Rotate the credential-shaped OpenAI, Weaviate, and Cohere values currently
   present in the prototype RAG project's `.env.example`.
2. Replace that example file with placeholders before committing or sharing the
   prototype repository.
3. Set `rag_weaviate_url` or include `WEAVIATE_URL` in the secret.
4. Run the normal Terraform plan and apply for the correct account workspace.
5. If Terraform created the empty secret container, populate the ARN shown by
   `terraform output -raw rag_credentials_secret_arn`.
6. Invoke `rag-indexer` once with `{"rebuild": true}`.
7. Test an authenticated chat, an allergen question, an `out` dish, a menu
   edit, a removal, and a failed-message retry.
8. Monitor the indexer and chat log groups plus
   `dish_index_updates_dlq_url`.
9. Before a public launch, add provider billing alerts and decide whether the
   aggregate chat throttle needs stronger per-user quotas or AWS WAF rules.
