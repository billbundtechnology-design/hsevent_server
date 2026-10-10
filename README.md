# Rentos API

The backend is an Express 5 and TypeScript service backed by MongoDB through Mongoose. It includes JWT bearer authentication and role-based permission middleware.

## Getting started

1. Install Node.js 20 or later and run MongoDB as a replica set locally, or obtain a MongoDB Atlas/replica-set connection URI. Booking create/confirm operations require transactions.
2. Copy `.env.example` to `.env`; set `MONGODB_URI`, `CORS_ORIGINS`, a unique random `JWT_SECRET` of at least 32 characters, and `PUBLIC_BUSINESS_ID` to the storefront's business UUID. To enable inventory image uploads, also set all three `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` values.
3. From this directory, run `npm install` and then `npm run dev`.
4. Check `http://localhost:4000/api/v1/health`. The endpoint returns `503` when MongoDB is unavailable.

## Scripts

- `npm run dev` starts the API with file watching.
- `npm run build` compiles TypeScript into `dist/`.
- `npm start` runs the compiled API.
- `npm run typecheck` checks TypeScript without emitting files.
- `npm test` runs booking pricing/validation unit tests and the replica-set integration suite when `MONGODB_TEST_URI` is set.
- `npm run test:integration` runs the transaction-backed booking integration suite; use an isolated replica-set database named `rentos_test_*`.

The API uses `/api/v1`, JSON request bodies limited to 1 MB, security headers, an explicit CORS allowlist, structured request logs, and `X-Request-Id` response headers. The API contract and implementation notes are in [api.md](./api.md).

## Authentication

Before the first user exists, configure `BOOTSTRAP_OWNER_NAME`, `BOOTSTRAP_OWNER_EMAIL`, `BOOTSTRAP_OWNER_PASSWORD` (12-72 UTF-8 bytes), and `BOOTSTRAP_BUSINESS_NAME` in the ignored `.env` file, then run `npm run bootstrap-owner`. Bootstrap refuses to run once any user exists and prints the generated business ID; set that value as `PUBLIC_BUSINESS_ID` for the storefront.

- `POST /api/v1/auth/login` accepts `{ "email", "password" }` and optionally a `businessId` when an account belongs to multiple businesses. It returns a 15-minute signed JWT access token.
- `GET /api/v1/auth/me` returns the current user, business, role, and permissions.

Send the access token in the `Authorization: Bearer <token>` header. Logout is client-side: discard the token. There are no server-side sessions, auth cookies, or CSRF tokens. Tokens expire after 15 minutes; the API checks the user and active business membership on authenticated requests, so disabling an account or membership takes effect immediately. Login is rate limited. Passwords are hashed with bcrypt.

Authorization roles are `owner`, `manager`, `booking_staff`, `inventory_staff`, `delivery_staff`, and `finance_staff`. Route handlers should use `authenticate` followed by `requirePermission('resource.action')` from [auth.middleware.ts](./src/middleware/auth.middleware.ts). The middleware also supplies the authenticated membership's `businessId`; use it for every business-scoped query and never trust a client-supplied business ID for authorization.

Authentication follows a route/controller/service structure: [auth.routes.ts](./src/routes/auth.routes.ts) composes middleware and endpoints, [auth.controller.ts](./src/controllers/auth.controller.ts) shapes HTTP responses, and [auth.service.ts](./src/services/auth.service.ts) owns authentication and persistence rules. Reuse [validate.middleware.ts](./src/middleware/validate.middleware.ts) with schemas from [validation/](./src/validation) for Zod request validation, and configure reusable request throttles with [rate-limit.middleware.ts](./src/middleware/rate-limit.middleware.ts).

## Staff and customers

Staff endpoints are mounted at `/api/v1/staff`; customer endpoints are mounted at `/api/v1/customers`. Both require a bearer token, enforce permissions, and scope reads/writes to the authenticated membership's business.

- Customers support paginated/searchable listing, creation, profile reads, version-checked updates, and archive (not hard delete). Corporate customer profiles require a company name.
- Staff supports paginated/searchable listing, profile reads, role/status updates, token revocation, and invitations. Only owners have `staff.read`/`staff.manage`; invitations cannot grant the owner role.
- `POST /api/v1/staff/invitations` returns a one-time invitation token because email delivery is not configured. Deliver it securely out-of-band. Invitations expire after 72 hours.
- `POST /api/v1/staff/invitations/accept` accepts `{ "token": "..." }` for an existing account. A new account must also provide `name` and a 12-72-byte `password`.

Customer booking-history endpoints return paginated booking summaries.

## Bookings

- Public `POST /api/v1/public/booking-requests` creates a pending request. It requires `Idempotency-Key` (16-128 characters), derives the business from `PUBLIC_BUSINESS_ID`, resolves customer contact details within that business, and re-reads listing prices from MongoDB. The response includes a one-time-to-the-caller access token (returned again for a same-key retry) for `GET /api/v1/public/booking-requests/:id` via `X-Booking-Access-Token`.
- Admin `/api/v1/bookings` routes support paginated search, create, read, version-checked update, confirm, cancellation preview/confirmation, and complete. They use bearer permissions and business scoping from the authenticated membership.
- Rental prices multiply by the number of started 24-hour periods. Staff may set `discountPercent`; the configured business tax is calculated on the post-discount subtotal. Percentages allow up to two decimal places. The configured deposit is calculated on the tax-inclusive total, snapshotted at booking creation, and must be paid before confirmation.
- Booking line names/prices and the tax/discount/deposit breakdown are snapshots. Confirming checks deposit and availability and creates allocations transactionally. Cancellation requires a preview, explicit confirmation, and the current booking version; it returns the configured refund impact but never issues a refund. Completion releases active allocations.
- Booking create/update/confirm/cancel/complete writes a durable notification outbox event in the same transaction. A pluggable delivery worker can claim and retry events; no messaging provider is configured, so queued events are not sent until one is connected.
- Add active public listings directly in MongoDB until catalogue CRUD is implemented. Rental listings need `totalUnits`, `damagedUnits`, and `missingUnits`; venue listings may set `capacity` and must have status `available`.
- Configure local MongoDB as a replica set (or use Atlas) before testing booking writes. Transactions intentionally fail on standalone MongoDB rather than allowing partial booking or allocation writes.

Password recovery is not implemented yet. Staff invitation email delivery requires an email provider; until configured, invitation tokens must be delivered securely out-of-band.

## Inventory and images

Inventory endpoints are mounted at `/api/v1/inventory` and require bearer authentication plus inventory permissions. Upload images with `POST /api/v1/inventory/images` as `multipart/form-data`, using the field name `image`. JPEG, PNG, and WebP files are accepted up to 5 MiB. The upload endpoint returns Cloudinary's `url` and `publicId`; include them as `imageUrl` and `imagePublicId` when creating or updating an item. The API verifies that the image belongs to the authenticated business. Cloudinary credentials are optional for starting the API, but uploads return `503` until they are configured.

Use the stock-adjustment and condition-report endpoints to change stock and damaged/missing counts; inventory edits do not directly alter those quantities. Inventory writes that participate in stock/allocation changes require a MongoDB replica set or Atlas.

## Venues, services, and public listings

Venue records and planning services/packages are catalogue listings with `kind: "venue"` and `kind: "planning"` respectively. The authenticated admin APIs are mounted at `/api/v1/venues`, `/api/v1/services`, and `/api/v1/listings`. Listing writes are business-scoped, version-checked where applicable, audited, and permission-gated. Services retain their booking snapshots when archived. Publish/unpublish listings with the dedicated listing actions; public endpoints expose only active and published fields.

Venue records include capacity, amenities, address, and optional pre/post booking buffers. Venue availability checks and booking confirmation honor overlapping bookings and blackout windows. Blackout creation rejects conflicts with existing reservations and is transactional; use MongoDB replica-set/Atlas configuration. Public catalogue routes include `GET /api/v1/public/listings`, `GET /api/v1/public/listings/:listingId`, `GET /api/v1/public/categories`, and `GET /api/v1/public/availability`. Set `PUBLIC_BUSINESS_ID` to enable the storefront routes. Date-filtered catalogue search checks a full Lagos-local day and is capped at 500 matching listings.

## Dispatch and returns

Create a dispatch plan for a confirmed rental booking with `POST /api/v1/bookings/:id/dispatches`, then use the `/api/v1/dispatches` endpoints to update its schedule, maintain named checklists, mark outbound item quantities, and record incremental returns. Checklist, dispatch, and return mutations require an `Idempotency-Key`. Assigned staff must be active business members.

Return reconciliation updates damaged/missing inventory counts and stock-movement history transactionally; allocations are released only when all dispatched quantities are returned or recorded missing. Rental bookings cannot be completed before a dispatch is fully reconciled and cannot be cancelled after dispatch. Cancelling a booking before dispatch also cancels its scheduled dispatch plan. These operations require MongoDB replica-set transactions. 500 matching listings.

## Staff and settings

Staff APIs support business-scoped listing, role/status management, invitations, invitation acceptance, invitation revocation, and token revocation. Invitation tokens are returned once for manual secure delivery; do not put them in logs. Only owners can manage staff.

Settings APIs persist business profile, booking policy configuration (deposit, tax, cancellation cutoff/refund percentages), notification preferences, invoice branding, and role permission summaries. Settings reads are available to owners and managers; updates are owner-only. 500 matching listings.

## Reports and exports

Authenticated `/api/v1/reports` endpoints provide summary, booking, current inventory, and payment/refund reports. Booking metrics use event dates; payment/refund metrics use transaction timestamps; inventory is a current snapshot, with utilization measured against total units. CSV booking/payment exports are business-scoped, omit customer contact details, protect spreadsheet formula cells, and are limited to 10,000 rows. Reports require `reports.read`; CSV exports require `reports.export`.

## Enquiries

The public `POST /api/v1/public/enquiries` endpoint accepts contact/event details, requires an email or phone number, and is rate-limited. Set `PUBLIC_BUSINESS_ID` to enable it. Staff can search and manage enquiries through `/api/v1/enquiries`; all reads and updates are business-scoped and permission-gated. Converting an enquiry creates a pending booking in the same MongoDB transaction, links it to the enquiry, records an audit event, and is safe to retry without creating duplicates.

## Payments and refunds

Finance staff and owners can list payment records, record manually verified bank-transfer/POS/cash receipts against a booking, and record manually executed refunds against a payment. Payment and refund writes require a 16-128 character `Idempotency-Key`, enforce booking balances and refundable amounts, and update the booking balance plus audit history in MongoDB transactions. External references must be unique within the business. A successful payment prevents repricing its booking. Refunds do not automatically cancel bookings. This integration does not include hosted checkout or a payment-provider webhook; verify receipt/refund execution before recording it. Use a MongoDB replica set or Atlas for these transaction-backed writes.
# hsevent_server
