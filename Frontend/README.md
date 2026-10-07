# Snowfox sushi landing page

A phone-first React + Vite restaurant landing page with Amazon Cognito-backed customer and admin accounts and a DynamoDB-backed menu editor. On small screens, the fixed bottom navigation keeps public navigation and the consolidated admin workspace within easy reach.

## Run locally

```bash
npm install
npm run dev
```

Use `npm run build` for a production build and `npm run lint` for lint checks.

## AWS configuration

The Admin button opens a login modal that uses the Cognito user pool created by `Backend/terraform`. Copy `.env.example` to `.env.local`, then fill it from the Terraform outputs:

```dotenv
VITE_COGNITO_USER_POOL_ID=<terraform output -raw cognito_user_pool_id>
VITE_COGNITO_CLIENT_ID=<terraform output -raw cognito_user_pool_client_id>
VITE_COGNITO_ADMIN_GROUP=<terraform output -raw cognito_admin_group_name>
VITE_API_BASE_URL=<terraform output -raw api_base_url>
VITE_DISH_IMAGES_BASE_URL=<terraform output -raw dish_images_base_url>
```

Vite reads these values when the development server or production build starts, so restart it after changing the environment file.

## Deploy to S3 and CloudFront

For automated checks and deployments, see the
[GitHub Actions setup guide](../.github/GitHubActions.md).

The `default-staging` and `default-prod` Terraform workspaces create separate
private frontend buckets and CloudFront distributions:

| Workspace | Site URL |
| --- | --- |
| `default-staging` | `https://www.staging.snowfoxcorvallis.com` |
| `default-prod` | `https://www.snowfoxcorvallis.com` |

Apply the backend Terraform for the intended workspace before deploying the
frontend. From `Backend/terraform`, read `frontend_bucket_name` and verify
`frontend_environment`; then build from this folder with that environment's
five `VITE_*` values. Backend Terraform plans also require the root domain in
the standard Terraform environment variable:

```powershell
$env:TF_VAR_frontend_root_domain_name = "snowfoxcorvallis.com"
```

```powershell
npm ci
npm test
npm run lint
npm run build
```

Upload the contents of `dist`, not the `dist` directory itself. Upload the
fingerprinted assets before the application shell:

```powershell
$frontendBucket = terraform -chdir=..\Backend\terraform output -raw frontend_bucket_name

aws s3 sync .\dist\assets "s3://$frontendBucket/assets" `
  --cache-control "public,max-age=31536000,immutable"

aws s3 sync .\dist "s3://$frontendBucket" `
  --delete `
  --exclude "assets/*" `
  --cache-control "no-cache,no-store,must-revalidate"
```

The bucket blocks all public access. Test the custom CloudFront URL rather than
an S3 object URL. The application shell is not cached by CloudFront, while
fingerprinted files under `assets/` are cached for repeat visits. Older hashed
assets are intentionally retained during deployments and can be removed later
after the rollback/cache window has passed.

## Admin workspace

After an administrator signs in, the desktop header shows one **Admin
workspace** button instead of separate buttons for every management feature.
On phones, the same launcher is the **Manage** item in the four-item admin
bottom navigation. Administrator sign-out is inside the workspace. The
workspace opens the existing Pickup orders, Menu, and Announcements tools
without changing their API or authentication behavior.

## Customer accounts

The **Sign in** button opens the customer account flow. Existing customers sign
in with email and password. New customers can create an account with their full
name, phone number, email, and password, then confirm the account using the code
sent to their email address.

The sign-in form also provides **Reset password** for customer and admin
accounts. Cognito sends a six-digit code to the account's verified email
address; the user enters that code and a new password in the same modal. The
browser calls Cognito directly for both reset steps, so no password or reset code
passes through API Gateway, Lambda, or DynamoDB.

The Terraform user pool currently uses Cognito's built-in email sender. This is
appropriate for development, but AWS limits the default sender to 50 messages
per AWS account per day. Configure the user pool with a verified Amazon SES
domain identity before relying on account emails at production volume.

Name and phone are stored as Cognito's standard `name` and `phone_number`
attributes. Phone numbers must include the country code, for example
`+1 415 555 2671`; formatting characters are removed before registration. The
current user pool verifies email only, so the phone number is stored but is not
SMS-verified and cannot be used to sign in.

`VITE_COGNITO_ADMIN_GROUP` should match the backend admin group. The ID token must include that value in its `cognito:groups` claim before the editor is shown, and the API checks the same claim before accepting a save.

Admin sessions are restored through Cognito's validated session cache. The previous UI's raw token display and duplicate session-token cache have been removed.

## Menu chat

Signed-in customers can open **Chat** and create a live session through
`POST /chat/sessions`. The backend generates the authoritative chat ID and
binds it to the Cognito user's `sub`; the browser does not create or persist an
authoritative ID.

Messages are sent to
`POST /chat/sessions/{chatId}/messages` with a fresh Cognito ID token and a
client request ID. Retrying the same failed submission reuses that request ID
so the backend can return the already stored exchange without duplicating
history. The UI displays connecting, thinking, live, and sanitized error states
and prevents concurrent sends.

Both chat URLs are derived from `VITE_API_BASE_URL`, so no API keys or additional
Vite variables are used. OpenAI, Weaviate, and Cohere credentials remain in AWS
Secrets Manager and are never sent to the browser.

## Pickup ordering

Customers can add available dishes to an order from the main menu, adjust
quantities in the cart, sign in, and review a pickup-only checkout. Dishes
marked **Out** cannot be added. The checkout has no payment fields or payment
processing. Customers are instructed to pay at a Fred Meyer checkout register
when they pick up their order.

The order endpoint is derived automatically as
`${VITE_API_BASE_URL}/orders`. The frontend sends an authenticated `POST`
request containing a client request ID, `fulfillment: "pickup"`, the customer's
pickup name and phone number, an optional note, and only
`{ dishId, quantity }` for each line item. Prices and availability must be
looked up and validated again by the backend; values shown by the browser are
not authoritative.

If `VITE_API_BASE_URL` is empty, checkout remains usable as a frontend demo. It
produces a confirmation explicitly marked as a local preview and does not send
an order to the restaurant. The cart and contact form live only in React memory
and are cleared by a page reload.

## Restaurant announcements

The landing page loads active announcements from the public
`GET /announcements` endpoint derived from `VITE_API_BASE_URL`. Visitors do not
need to sign in to see them. The backend returns only announcements that are
published and within their configured start and end times, so drafts and
scheduled internal content are not exposed to the public browser.

Administrators can open **Admin workspace → Announcements** after signing in to
create, edit, publish, schedule, or delete notices. The editor uses the existing
Cognito admin session and the existing API base URL; no additional Vite
environment variable is required. Each announcement can be categorized as
general, discount, closure, or event and can have a priority that controls
display order.

A discount announcement may display a promo code, but the code is
informational only. This feature does not change menu prices or order totals.
Implementing redeemable discounts would require separate server-side promotion
validation and price calculation in the order Lambda.

## Order tracking and admin status

Signed-in customers can open **My orders** to see their order history. When the
restaurant confirms an order, the customer sees its pickup time and any message
the restaurant added. The restaurant message is customer-visible and is
separate from the pickup note the customer entered at checkout.

Administrators can expand an order in **Admin orders** and choose an allowed
next status. Confirming an order requires a future pickup date and time. The
browser converts the value selected in the administrator's local date-time
picker to a canonical UTC ISO timestamp before sending it to the API. An
optional **Message to customer** accepts up to 500 characters for any status
change. A confirmation dialog summarizes the status, pickup time, and message
before the update is submitted.

Pickup time and restaurant message describe the order's current status. A later
status change removes a pickup time that no longer applies and replaces or
clears the previous restaurant message. Both the administrator list and
customer order history use the values returned by the backend.

When the deployed backend changes an order to `CONFIRMED`, `CANCELLED`,
`REJECTED`, or `FAILED_TO_PICKUP`, the Orders DynamoDB Stream and a separate
EventBridge Pipe, SQS, Lambda, and SES pipeline email the address stored with
the order.
The frontend sends no email address as part of the admin status request and
needs no additional API URL or environment variable. The pipeline intentionally
does not store email-idempotency records, so an uncommon infrastructure retry
can result in a duplicate customer email.

Confirmed orders also have a separate **Mark as not picked up** action. The
page indicates when the device clock reaches the scheduled pickup time, but it
does not use an administrator's potentially incorrect clock as authorization.
The action opens a confirmation dialog, explains that the customer's failure
count will increase, and accepts an optional customer-visible message. The
frontend sends only the order ID and requested status details; the backend
derives customer identity and timestamps from the stored order and is the
authoritative check that the pickup time has passed.

After a successful action, both Admin Orders and the customer's own **My
orders** view show the original scheduled pickup time, when the no-show was
recorded, the terminal failed-pickup status, and the restaurant message.
Administrators can lazily open **View customer pickup history** on an order to
load the aggregate count and paginated order history. Aggregate history is
admin-only and is fetched through
`GET /admin/orders/{orderId}/customer/pickup-failures`; customers see only
their own individual order.

## Menu editing

The page loads its public menu from `GET /dishes`. After login, open **Admin
workspace → Menu**. Saving sends the complete ordered menu to the
Cognito-protected `PUT /dishes` endpoint, which stores it atomically in
DynamoDB. Browser `localStorage` is no longer used for dish data.

Each dish has an admin-selectable availability value: `available` or `out`.
The public menu shows the corresponding **Available** or **Out** badge. Legacy
dishes without this field default to Available and receive an explicit value on
their next save.

Dish images are optional JPEG, PNG, or WebP files up to 5 MiB. Choosing an
image creates a local preview only. On **Save menu**, the editor requests an
admin-only URL from `POST /dish-images/upload-url`, uploads only newly selected
files directly to S3, and stores each returned S3 key with the dish metadata.
Existing unchanged images are not uploaded again. Public cards build their
image URLs from `VITE_DISH_IMAGES_BASE_URL` and load them lazily.

An empty or unavailable API falls back to the sample dishes in `src/App.jsx`. The first successful admin save publishes those samples to DynamoDB.

The restaurant name, address, hours, story, and initial menu content are presentation samples and can be changed in `src/App.jsx`.
