# Rentos Backend API

> **Status: implementation contract.** Rentos has an Express/TypeScript API backed by MongoDB. Implemented routes and behavior are documented alongside remaining planned surfaces; the admin and customer Next.js applications may still use local seed data or in-memory adapters until connected to the API.

## 1. Scope

The API supports:

- The Rentos admin workspace: bookings, calendar, inventory, dispatch and returns, event planning, venues, customers, payments, reports, services and packages, staff, and settings.
- The customer storefront: public catalogue discovery, availability checks, and booking enquiries/requests.
- Authentication, authorization, audit history, and operational business rules shared by both applications.

The UI is a single-business demo today. The data model includes `businessId` so the service can safely support multiple Rentos businesses if that becomes a product requirement. Every authenticated query and mutation must be scoped to the caller's business.

## 2. API conventions

| Concern | Contract |
|---|---|
| Base URL | `https://<api-host>/api/v1` |
| Content type | `application/json; charset=utf-8` |
| Authentication | Short-lived signed JWT access token in the `Authorization: Bearer <token>` header. No authentication cookies or server-side sessions. |
| Dates | ISO 8601. Date-only event dates use `YYYY-MM-DD`; instants include an offset or `Z`. Interpret business-facing dates in `Africa/Lagos`. |
| Currency | NGN. API amounts are integer minor units (`amountKobo`) to avoid floating-point arithmetic. `100000` means ₦1,000.00. |
| IDs | Opaque UUIDs for database records. Human-readable booking references (for example, `RNT-2401`) are separate display identifiers. |
| List pagination | `?page=1&pageSize=25`, maximum `pageSize=100`; stable order by `createdAt` descending unless specified. |
| Filtering | Resource-specific query parameters listed below. Search is case-insensitive and trimmed. |
| Mutation safety | Require `Idempotency-Key` on public booking requests and payment/checkout creation. Use `If-Match` or a `version` field for concurrent admin edits. |
| Deletion | Prefer archive/deactivate for referenced business records. Do not hard-delete financial records or bookings. |

List responses use this envelope:

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "pageSize": 25,
    "total": 0,
    "totalPages": 0
  }
}
```

Single-resource and command responses return the resource under `data`, except `204 No Content` responses.

### Error format

All errors use `application/problem+json` with a stable machine-readable `code`:

```json
{
  "type": "https://api.rentos.example/problems/validation-error",
  "title": "Request validation failed",
  "status": 422,
  "code": "VALIDATION_ERROR",
  "detail": "One or more fields are invalid.",
  "errors": [
    { "field": "eventDate", "code": "required", "message": "Event date is required." }
  ],
  "requestId": "req_01J..."
}
```

Use `400` for malformed requests, `401` for unauthenticated callers, `403` for insufficient permissions, `404` for missing or out-of-scope resources, `409` for state/version/availability conflicts, `422` for field or business-rule validation, `429` for throttling, and `500` for unexpected server errors. Never return stack traces, credentials, payment secrets, or another business's data.

## 3. Authentication and permissions

### Endpoints

| Method and path | Access | Purpose |
|---|---|---|
| `POST /auth/login` | Public, rate-limited | Verify email and password; return a short-lived access token. |
| `GET /auth/me` | Authenticated | Return the current user, business membership, and permissions. |
| `POST /auth/password/forgot` | Public, rate-limited | Send a time-limited reset link without revealing whether an email exists. |
| `POST /auth/password/reset` | Public, token required | Set a new password and increment the user's auth version to invalidate existing tokens. |
| `POST /staff/invitations` | `staff.manage` | Create a staff invitation. Until email delivery is configured, return its one-time token to the authorized caller for secure manual delivery. |
| `POST /staff/invitations/accept` | Public, rate-limited | Accept the invitation using `{ "token", "name", "password" }` for new users; existing users use their invitation token. |

Login request:

```json
{ "email": "admin@example.com", "password": "..." }
```

Successful login returns `200` with a minimal user/business summary and a signed access token expiring after 15 minutes. Send the token in the `Authorization: Bearer <token>` header on authenticated requests. Logout is client-side: discard the token. Passwords are never returned. Login errors should use a generic message and consistent response to reduce account enumeration. Apply rate limits to login, reset, and invitation endpoints.

Initial roles and permissions:

| Role | Suggested permissions |
|---|---|
| Owner/Admin | All workspace operations, users, settings, and reports. |
| Manager | Bookings, customers, catalogue, venues, dispatch, and reports; no ownership or security settings. |
| Booking Staff | Bookings and customer records; no payment administration or staff/settings access. |
| Inventory Staff | Inventory and catalogue stock operations. |
| Delivery Staff | Read assigned bookings and update dispatch/return checklists. |
| Finance Staff | Read bookings/customers and manage payment records and reports. |

Permissions must be enforced server-side on every request; hiding UI controls is not authorization. Staff role labels in the current demo are descriptive only.

## 4. Core resource shapes

These are proposed normalized API representations. The current UI uses denormalized demo objects and display names; clients should migrate to IDs and nested resources when connecting to the API.

### Booking

```json
{
  "id": "UUID",
  "reference": "RNT-2401",
  "customerId": "UUID",
  "customer": { "id": "UUID", "name": "Amara Okafor" },
  "eventName": "Amara & Chidi's wedding",
  "businessArm": "planning",
  "eventDate": "2026-10-17",
  "startAt": null,
  "endAt": null,
  "venueId": "UUID",
  "venue": { "id": "UUID", "name": "The Courtyard" },
  "status": "confirmed",
  "paymentStatus": "part_paid",
  "currency": "NGN",
  "subtotalKobo": 245000000,
  "discountKobo": 0,
  "taxKobo": 0,
  "totalKobo": 245000000,
  "paidKobo": 150000000,
  "balanceKobo": 95000000,
  "notes": null,
  "createdAt": "2026-09-01T12:00:00Z",
  "updatedAt": "2026-09-01T12:00:00Z",
  "version": 1
}
```

`businessArm` is `rentals`, `planning`, or `venue`. Booking `status` is `pending`, `confirmed`, `completed`, or `cancelled`. `paymentStatus` is derived: `unpaid` when paid is zero, `part_paid` when paid is between zero and total, and `paid` when paid equals total.

For the current manual-payment API, recorded payment entries are immediately `succeeded`; the returned payment status is derived as `succeeded`, `partially_refunded`, or `refunded` from its immutable refund records. Supported manual methods are `bank_transfer`, `pos`, and `cash`. Pending/failed gateway payments and `online` are not supported until a provider integration is added. Only verified successful payments net of verified refunds contribute to the booking's paid balance.

### Booking line

Each booking has one or more immutable-price snapshots:

```json
{
  "id": "UUID",
  "listingId": "UUID",
  "nameSnapshot": "Gold Chiavari chairs",
  "kind": "rental",
  "quantity": 100,
  "unitPriceKobo": 250000,
  "lineTotalKobo": 25000000,
  "rentalStartAt": "2026-10-16T08:00:00+01:00",
  "rentalEndAt": "2026-10-18T18:00:00+01:00"
}
```

Venue reservations are represented by the venue listing and the booking's reservation interval. Planning services may have quantity one. Snapshot name and price must not change if the catalogue is edited later.

### Other resources

- **Customer:** `id`, `businessId`, `name`, `email`, `phone`, `type` (`private` or `corporate`), optional billing/address fields, `createdAt`, `updatedAt`, `archivedAt`.
- **Inventory item:** `id`, `name`, `sku`, `category`, `totalUnits`, `damagedUnits`, `missingUnits`, `rentalRateKobo`, `active`, `version`. Available units are calculated, not directly edited.
- **Venue:** `id`, `name`, `capacity`, `priceKobo`, `unit` (for example `half_day` or `full_day`), amenities, status (`available`, `maintenance`, `inactive`), address, and booking buffer rules.
- **Listing/service:** `id`, `name`, `kind` (`rental`, `venue`, `planning`), `category`, description, `priceKobo`, `unit`, optional `capacity`, `active`, `popular`, `sortOrder`.
- **Payment:** `id`, `reference`, `bookingId`, `amountKobo`, `method`, `status`, optional provider/reference metadata, `recordedAt`, `createdBy`. Payment rows are append-only; corrections use a refund/reversal record.
- **Dispatch:** `id`, `bookingId`, `scheduledAt`, delivery address, assigned staff IDs, status, checklist and timestamps for dispatch/collection.
- **Audit event:** actor, business, resource type/ID, action, timestamp, request ID, and a redacted before/after diff.

## 5. Public storefront API

Public endpoints return only active, customer-visible fields. Never expose internal stock notes, customer records, staff data, or private booking details.

| Method and path | Purpose / query |
|---|---|
| `GET /public/listings` | Browse catalogue. Optional `kind`, `category`, `q`, `guestCount`, `eventDate`, `page`, `pageSize`, `sort`. |
| `GET /public/listings/{listingId}` | Listing details and public price/unit. |
| `GET /public/categories` | Active catalogue categories and counts. |
| `GET /public/availability` | Check rental quantities or venue dates. Requires `listingId`, `startAt`, `endAt`; rentals may pass `quantity`, venues may pass `guestCount`. |
| `POST /public/enquiries` | Submit a planning/contact enquiry without creating a confirmed booking; rate-limited to 10 requests per 15 minutes. |
| `POST /public/booking-requests` | Submit a customer bag as a pending booking request. Requires `Idempotency-Key`; response includes server-calculated `requiredDepositKobo` and whether a notification was enqueued. |
| `GET /public/booking-requests/{requestId}` | Read a request using `X-Booking-Access-Token`; expose only minimal customer-safe status. |

Public booking requests resolve to the single configured `PUBLIC_BUSINESS_ID`; do not accept a business ID from the request body. Configure it to the business UUID in the API environment.

### Catalogue filtering

`GET /public/listings?kind=venue&guestCount=50&q=garden&eventDate=2026-11-28`

- `kind` must be one of `rental`, `venue`, `planning`.
- `q` searches active listing name, category, and description.
- `guestCount` filters venues to capacity greater than or equal to the requested guest count.
- `eventDate` filters out rentals and venues that are unavailable for the full Lagos-local date. It is capped at 500 matching catalogue candidates; narrow broader queries by kind, category, or search term. It does not reserve stock.
- Return stable pagination and only active/published listings.
- The storefront currently filters the seed catalogue locally and its “bag” is browser state. Bag contents are untrusted; the server must re-fetch prices and availability at submission time.

### Availability response and rules

```json
{
  "data": {
    "listingId": "UUID",
    "startAt": "2026-10-16T08:00:00+01:00",
    "endAt": "2026-10-18T18:00:00+01:00",
    "requestedQuantity": 100,
    "availableQuantity": 324,
    "available": true
  }
}
```

- Rental availability is `totalUnits - damagedUnits - missingUnits - allocatedUnits` for overlapping active rental intervals.
- Venue availability is based on overlapping confirmed reservation intervals, venue operating hours, maintenance blocks, and configured setup/teardown buffers.
- Pending requests do not consume confirmed stock by default. If a future checkout/quote hold is introduced, the hold must have an explicit expiry and be allocated atomically.
- The availability response is advisory. Recheck within the transaction that confirms a booking or creates a hold; return `409 AVAILABILITY_CONFLICT` on a race.

### Enquiry request

```json
{
  "name": "Amina Yusuf",
  "email": "amina@example.com",
  "phone": "+2348012345678",
  "eventType": "wedding",
  "eventDate": "2026-11-28",
  "guestCount": 80,
  "message": "I would like help with styling and rentals."
}
```

The implemented endpoint validates contact details and message size, rate-limits submissions, and stores an optional source plus consent timestamp when `consent: true` is submitted. It derives the business from `PUBLIC_BUSINESS_ID`; never include a client-supplied business ID. Return `201` with an enquiry reference. Do not imply that an enquiry is a booking.

### Booking request

The API implements `POST /public/booking-requests`, the public-safe request status endpoint, and protected `/bookings` list/create/read/update/confirm/cancel/complete routes. Public storefront routing uses `PUBLIC_BUSINESS_ID`, configured server-side. Booking persistence includes line snapshots, pricing/deposit snapshots, and separate inventory allocation documents. Other endpoints in this contract remain planned unless described as implemented in the backend README.

`PATCH /bookings/{id}` accepts validated booking fields (and optional staff `discountPercent`) plus the current integer `version`; it reprices from active server-side listings and current business tax/deposit settings, updates only pending bookings, returns the new `ETag`, and rejects a revised total below the amount already paid.

```json
{
  "customer": {
    "name": "Amina Yusuf",
    "email": "amina@example.com",
    "phone": "+2348012345678"
  },
  "eventName": "Amina's engagement",
  "businessArm": "rentals",
  "eventDate": "2026-11-28",
  "startAt": "2026-11-28T08:00:00+01:00",
  "endAt": "2026-11-28T22:00:00+01:00",
  "venueId": null,
  "guestCount": 80,
  "deliveryAddress": "Lekki Phase 1, Lagos",
  "items": [
    { "listingId": "UUID", "quantity": 100 }
  ],
  "notes": "Please call before delivery."
}
```

On `POST /public/booking-requests`:

1. Validate required customer, event, date, quantities, and listing IDs.
2. Resolve/create a customer scoped to the business; normalize email and phone for matching, but do not merge records on name alone.
3. Load active listings and calculate prices on the server. Ignore client-supplied totals and prices.
4. Validate each item is compatible with the requested business arm and event interval.
5. Recheck availability and venue capacity; report conflicts as `409`.
6. Create a `pending` booking, immutable line snapshots, an audit record, and an opaque customer access token in one transaction. Reuse of an idempotency key with a different payload returns `409 IDEMPOTENCY_KEY_REUSED`.
7. Return `201` with a public-safe request ID/reference, `pending` status, server-calculated quote totals, and a notification acknowledgement. Do not confirm the booking or charge a payment method.

An admin subsequently confirms or declines the request. Customer request endpoints must not reveal private notes, internal audit history, or other customers' information.

## 6. Admin workspace endpoints

All `/bookings`, `/customers`, `/inventory`, `/venues`, `/services`, `/payments`, `/dispatches`, `/staff`, `/settings`, and `/reports` routes below require a valid bearer token and the listed permission.

### Bookings and calendar

| Method and path | Permission | Behavior |
|---|---|---|
| `GET /bookings` | `bookings.read` | Paginate; filters: `q`, `status`, `paymentStatus`, `businessArm`, `customerId`, `from`, `to`, `venueId`. |
| `POST /bookings` | `bookings.write` | Create an admin booking request; same validations/pricing as public request, optional staff `discountPercent`, actor recorded, and `Idempotency-Key` required. |
| `GET /bookings/{id}` | `bookings.read` | Return booking, customer summary, lines, payment summary, and dispatch summary. |
| `PATCH /bookings/{id}` | `bookings.write` | Edit allowed contact/event/notes/line fields while pending. Reprice on server; use `version`. |
| `POST /bookings/{id}/confirm` | `bookings.approve` | Require the booking deposit, then atomically recheck availability, reserve inventory/venue, and transition pending to confirmed. |
| `POST /bookings/{id}/cancellation-preview` | `bookings.cancel` | Return current booking version and policy-based cancellation/refund impact without changing state. |
| `POST /bookings/{id}/cancel` | `bookings.cancel` | Require `reason`, current `version`, and `confirm: true`; cancel transactionally, release allocations, and return policy impact without issuing a refund. |
| `POST /bookings/{id}/complete` | `bookings.complete` | Complete after fulfillment/return criteria are met. |
| `GET /calendar` | `bookings.read` | Return calendar events for `from`, `to`, optional `businessArm`, `venueId`, or `view`. Exclude cancelled bookings by default. |

Booking state transitions:

```text
pending -> confirmed -> completed
pending -> cancelled
confirmed -> cancelled (reason required; release future allocations)
```

Do not allow cancelled/completed bookings to be silently reopened or edited as if active. Use an audited administrative correction workflow if reopening is needed. Confirmation and allocation must be one database transaction with locking/constraints so two staff members cannot overbook the same stock or venue.

Calendar events should include booking reference, event name, interval, arm, venue, and status; access to customer contact details remains permission-gated. Use explicit event intervals where known. If only `eventDate` is available, treat it as a Lagos-local all-day calendar entry rather than inventing a time.

### Customers

| Method and path | Permission | Behavior |
|---|---|---|
| `GET /customers` | `customers.read` | Paginate; filters `q`, `type`, `archived`. Search name/email/phone. |
| `POST /customers` | `customers.write` | Create private or corporate customer. |
| `GET /customers/{id}` | `customers.read` | Return profile and permitted booking summary. |
| `PATCH /customers/{id}` | `customers.write` | Update profile with optimistic concurrency. |
| `POST /customers/{id}/archive` | `customers.write` | Archive rather than delete a referenced customer. |
| `GET /customers/{id}/bookings` | `bookings.read` | Paginated booking history. |

Customer create/update requests support `name`, optional `email` and `phone`, `type` (`private` or `corporate`), and optional `companyName` and `address`. Corporate customers require a company name. Customer mutations are scoped to the authenticated business; updates require the current integer `version` and return an `ETag`. Archived customers are retained and cannot be edited.

The customer profile and CRUD endpoints are implemented; `/customers/{id}/bookings` returns paginated booking summaries.

Booking counts, lifetime value, and outstanding balance are derived from non-cancelled bookings and valid payment/refund records. Do not trust or write these aggregate values from the client.

### Inventory

| Method and path | Permission | Behavior |
|---|---|---|
| `GET /inventory` | `inventory.read` | Paginate; filters `q`, `category`, `availability`, `condition`. |
| `POST /inventory` | `inventory.write` | Create item with unique SKU within the business and initial stock. |
| `POST /inventory/images` | `inventory.write` | Upload one JPEG, PNG, or WebP image (multipart field `image`, max 5 MiB) to Cloudinary. Returns `url` and `publicId`; pass these as `imageUrl` and `imagePublicId` on the item. Requires Cloudinary environment configuration. |
| `GET /inventory/{id}` | `inventory.read` | Return item, calculated availability, and recent movements. |
| `PATCH /inventory/{id}` | `inventory.write` | Update descriptive fields/rate/status; use `version`. |
| `POST /inventory/{id}/stock-adjustments` | `inventory.adjust` | Add/remove stock with quantity, reason, and audit entry. |
| `POST /inventory/{id}/condition-reports` | `inventory.adjust` | Record damaged/missing/repaired quantities and reason. |
| `GET /inventory/{id}/availability` | `inventory.read` | Check availability for a date interval and requested quantity. |

Never let callers directly set `availableUnits` or overwrite reservation allocations. Validate total, damaged, missing, and allocated quantities so none are negative and damaged + missing + allocated never exceed stock. When a stock adjustment would violate confirmed allocations, reject it with `409 STOCK_BELOW_ALLOCATED`.

Availability-filtered inventory lists calculate live availability; searches are capped at 5,000 matching items and return `422 AVAILABILITY_FILTER_TOO_BROAD` beyond that limit. Narrow larger searches by category or search term. Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` together to enable image uploads.

### Venues

| Method and path | Permission | Behavior |
|---|---|---|
| `GET /venues` | `venues.read` | Paginate; filters `q`, `status`, `minCapacity`. |
| `POST /venues` | `venues.write` | Create an unpublished venue listing. Publish it through `/listings/{id}/publish`. |
| `GET /venues/{id}` | `venues.read` | Return venue details and current status. |
| `PATCH /venues/{id}` | `venues.write` | Update details, price, capacity, or status. |
| `GET /venues/{id}/availability` | `venues.read` | Check availability over `startAt`/`endAt`; optional `guestCount` is checked against capacity. |
| `POST /venues/{id}/blackouts` | `venues.write` | Add maintenance/closed interval with reason. |
| `DELETE /venues/{id}/blackouts/{blackoutId}` | `venues.write` | Remove a blackout. |

Venue status `maintenance` or `inactive` prevents new confirmation. Reducing capacity below a confirmed booking's guest count must be rejected or require a documented resolution.

### Services and packages / public listings

| Method and path | Permission | Behavior |
|---|---|---|
| `GET /services` | `catalogue.read` | Paginate planning services/packages; filters `q`, `category`, `status`. |
| `POST /services` | `catalogue.write` | Create a planning service/package, including optional image and feature list. |
| `GET /services/{id}` | `catalogue.read` | Return details and booking usage counts by status. |
| `PATCH /services/{id}` | `catalogue.write` | Update details, price, features, and active status with `version`. |
| `POST /services/{id}/archive` | `catalogue.write` | Hide from new storefront use; retain booking snapshots. |
| `GET /listings` | `catalogue.read` | Admin catalogue including inactive records and operational fields. |
| `POST /listings` | `catalogue.write` | Create an unpublished venue or planning listing; create rental listings through `/inventory`. |
| `GET /listings/{id}` | `catalogue.read` | Get admin listing details. |
| `PATCH /listings/{id}` | `catalogue.write` | Update shared listing metadata and price with `version`; update venue-specific fields through `/venues`. |
| `POST /listings/{id}/publish` | `catalogue.publish` | Publish to the customer storefront. |
| `POST /listings/{id}/unpublish` | `catalogue.publish` | Remove from the storefront while retaining existing booking snapshots. |

Venue and service/package records use the shared listing model (`kind: venue` or `kind: planning`). A venue supports capacity, amenities, address, and pre/post booking buffer minutes. Planning listings support a `features` array for service/package contents. Upload listing images using the existing `/inventory/images` endpoint and submit the returned `imageUrl` and `imagePublicId`; ownership is validated against the authenticated business.

Price updates affect new quotes only. Existing booking line snapshots keep their accepted price unless an authorized user explicitly amends a pending booking and the customer is shown the revised quote.

### Payments and refunds

| Method and path | Permission | Behavior |
|---|---|---|
| `GET /payments` | `payments.read` | Paginate; filters `bookingId`, `status`, `method`, `from`, `to`. |
| `POST /bookings/{id}/payments` | `payments.record` | Record a manually verified bank transfer, POS, or cash payment. Requires `Idempotency-Key`. |
| `GET /payments/{paymentId}` | `payments.read` | Return payment details, booking reference, and immutable refund records. |
| `POST /payments/{paymentId}/refunds` | `payments.refund` | Record a manually executed and verified refund. Requires `Idempotency-Key`; the original payment remains unchanged. |

Manual payment request:

```json
{
  "amountKobo": 10000000,
  "method": "bank_transfer",
  "externalReference": "BANK-REF-OPTIONAL",
  "recordedAt": "2026-10-10T10:00:00+01:00",
  "notes": "Deposit verified by finance."
}
```

Refund request:

```json
{
  "amountKobo": 2000000,
  "method": "bank_transfer",
  "externalReference": "REFUND-REF-OPTIONAL",
  "reason": "Booking cancellation refund",
  "refundedAt": "2026-10-10T10:00:00+01:00"
}
```

Rules:

- Reject zero/negative amounts and amounts greater than the remaining balance; overpayments are not supported.
- `Idempotency-Key` must be 16-128 characters; same-key/same-payload retries return the original result, while key reuse with different details returns `409 IDEMPOTENCY_KEY_REUSED`.
- Payment records require a finance/owner-authorized staff member to verify funds were received. API-created manual payments are recorded as successful immediately; no payment gateway is integrated.
- Payment and refund external references, when supplied, are unique within a business. Card numbers and CVV are never accepted or stored.
- Compute `paidKobo`, `balanceKobo`, and `paymentStatus` transactionally from payment records minus successful refunds. Overpayments are rejected.
- Refunds are separate immutable records, can only be recorded after staff verify the refund was executed, and cannot exceed the payment's remaining refundable amount.
- Booking totals cannot be edited after a successful payment has been recorded. Refunds do not automatically cancel bookings or release inventory.

Hosted checkout, payment-provider webhooks, pending provider payments, and asynchronous provider refund processing are not implemented yet. Configure a replica-set MongoDB or Atlas: payment/refund writes update ledger records, booking balances, and audit events in a single transaction.

### Dispatch and returns

| Method and path | Permission | Behavior |
|---|---|---|
| `GET /dispatches` | `dispatch.read` | Paginate; filters `status`, `from`, `to`, `bookingId`, `assignedStaffId`. `overdue` is derived from expected return and unresolved quantities. |
| `POST /bookings/{id}/dispatches` | `dispatch.write` | Create one dispatch plan for a confirmed booking with active rental allocations. Requires `Idempotency-Key`. |
| `GET /dispatches/{id}` | `dispatch.read` | Return schedule, assignment, checklist, rental item snapshots, and reconciliation. |
| `PATCH /dispatches/{id}` | `dispatch.write` | Update schedule, address, assigned staff, or internal notes with `version`; only before dispatch. |
| `POST /dispatches/{id}/checklist` | `dispatch.update` | Idempotently record a named preparation, dispatch, collection, or return check. Requires `Idempotency-Key`. |
| `POST /dispatches/{id}/mark-dispatched` | `dispatch.update` | Record actual dispatch time and quantity per rental item. Requires `Idempotency-Key`. |
| `POST /dispatches/{id}/mark-returned` | `dispatch.update` | Record incremental returned, damaged, and missing quantities per rental item. Requires `Idempotency-Key`. |

Dispatch creation snapshots rental booking lines and requires matching active allocations. Mark-dispatched quantities must match confirmed booking quantities. All checklist, outbound, and return operations are idempotent: the same key/payload returns the prior result; reuse with a different payload returns `409 IDEMPOTENCY_KEY_REUSED`. Staff assignments must be active memberships in the business.

Return updates are incremental. Returned quantities include damaged returned items; `damagedQuantity` cannot exceed `returnedQuantity`. Any `missingQuantity` is treated as reconciled but is added to inventory's missing count; damaged returns add to the damaged count. Reconciled quantities are removed from the active rental allocation immediately; condition changes, stock movements, dispatch updates, and audit entries commit in one transaction. Do not mark a rental booking complete until a dispatch exists and all dispatched units are returned or recorded missing. A booking cannot be cancelled once rental items have been dispatched; cancelling it before dispatch also cancels its dispatch plan.

Dispatch status is `scheduled`, `preparing`, `dispatched`, `partially_returned`, `returned`, `overdue`, or `cancelled`. `overdue` is derived from an unreturned scheduled item past its expected return time; it should not be manually set as an arbitrary status.

### Staff and settings

| Method and path | Permission | Behavior |
|---|---|---|
| `GET /staff` | `staff.read` | List active/invited/suspended staff and role summaries. |
| `GET /staff/{id}` | `staff.read` | Get staff membership details. |
| `PATCH /staff/{id}` | `staff.manage` | Update allowed staff role or active/suspended state; owner memberships and self-suspension are prohibited. |
| `GET /staff/invitations` | `staff.read` | Paginate invitations; filters `q` and derived status (`pending`, `accepted`, `expired`, `revoked`). Never return invitation tokens or hashes. |
| `POST /staff/invitations` | `staff.manage` | Invite using email and allowed role; returns a one-time token for secure out-of-band delivery. |
| `DELETE /staff/invitations/{id}` | `staff.manage` | Revoke a pending invitation and suspend its invited membership. |
| `DELETE /staff/{id}/tokens` | `staff.manage` | Increment the user's auth version, invalidating all outstanding access tokens. |
| `GET /settings` | `settings.read` | Read business profile, booking policies, notifications, invoice branding, and roles. |
| `GET /settings/roles` | `settings.read` | Return the supported roles and their current permission lists. |
| `PATCH /settings/business-profile` | `settings.manage` | Update business name, address, currency (`NGN`), or timezone (`Africa/Lagos`). |
| `PATCH /settings/booking-policies` | `settings.manage` | Save deposit/tax percentages, cancellation cutoff hours, and refund percentages before/after cutoff; percentages allow up to two decimal places. |
| `PATCH /settings/notifications` | `settings.manage` | Save booking request, payment, dispatch, and return notification preferences. |
| `PATCH /settings/invoice-branding` | `settings.manage` | Save invoice display name and footer. |

Settings are business-scoped, persisted on the business record, and changes are audited. Owners and managers can read settings; only owners can change them. Deposit and tax settings are applied when bookings are created or repriced; applied percentages and amounts are snapshotted on each booking. A deposit is required before confirmation. Cancellation previews calculate the refund impact using the current cutoff policy, but never issue refunds automatically. Notification preferences gate transactional booking notifications written to the durable outbox; a delivery adapter must be configured by a worker to send them. The existing API supports only `NGN` and `Africa/Lagos`. Never provide a production “reset all demo data” endpoint.

### Reports and exports

| Method and path | Permission | Behavior |
|---|---|---|
| `GET /reports/summary` | `reports.read` | Date filters `from`, `to`. Booking value/outstanding uses event dates and excludes cancelled bookings; collected/refunded totals use transaction dates. |
| `GET /reports/bookings` | `reports.read` | Event-date booking counts and totals grouped by `day`, `week`, or `month`, status, and business arm. |
| `GET /reports/inventory` | `reports.read` | Current snapshot grouped by category: total, currently allocated/available, damaged, missing, and utilization. |
| `GET /reports/payments` | `reports.read` | Successful payment/refund totals grouped by transaction period and method; date filters apply to each transaction's own date. |
| `GET /reports/exports/bookings` | `reports.export` | CSV booking export; filters `from`, `to`, `status`, `businessArm`. |
| `GET /reports/exports/payments` | `reports.export` | CSV ledger export; filters `from`, `to`, `method`; minimizes customer data. |

Reports are derived from persisted data and scoped to the authenticated business. `from` and `to` are inclusive ISO calendar dates (`YYYY-MM-DD`). Booking reports compare those dates directly with the stored event-date field; payment/refund reports include transactions from the start of `from` through the end of `to` in UTC and return the date basis in metadata. Inventory is a current snapshot and has no historical range; utilization is allocated units divided by total units. Only successful manual payments/refunds are currently represented. CSV output quotes cells and neutralizes spreadsheet formula-leading values. Exports are capped at 10,000 rows; narrow the date range if `422 EXPORT_TOO_LARGE` is returned.

### Enquiries

| Method and path | Permission | Behavior |
|---|---|---|
| `GET /enquiries` | `bookings.read` | List customer enquiries with `status`, `q`, `from`, and `to` filters. |
| `GET /enquiries/{id}` | `bookings.read` | Read one enquiry. |
| `PATCH /enquiries/{id}` | `bookings.write` | Update status, internal notes, or assigned staff. |
| `POST /enquiries/{id}/convert-to-booking` | `bookings.write` | Create a pending booking linked to the enquiry. |

Enquiry status can be `new`, `contacted`, `qualified`, `converted`, or `closed`. List filters `from` and `to` compare inclusive ISO dates with the enquiry's event date. Updates require the current integer `version`; assignees must be active memberships in the same business. Conversion accepts booking details (`eventName`, `businessArm`, `eventDate`, optional interval/venue/guest count, and `items`) and uses the enquiry's contact record rather than client-supplied customer details. Conversion and booking creation are transactional and idempotent; retries return the linked booking rather than creating another.

## 7. Booking creation and business logic

All admin-created and customer-submitted bookings share server-side validation and pricing services:

1. **Identify business:** derive it from the authenticated membership for admin calls; resolve it from the public storefront hostname/configuration for public calls. Never accept an arbitrary `businessId` from an untrusted client.
2. **Validate input:** require a customer, event name, supported business arm, event date, valid interval, and at least one valid line for rental/service bookings. Venue bookings require a venue. Enforce configured maximum counts and text lengths.
3. **Resolve catalogue:** confirm every listing is active and belongs to the business. Validate kind, quantity, venue capacity, and allowed service combinations.
4. **Calculate quote:** read current server prices, multiply rental unit prices by quantity and each started 24-hour rental period (other listing kinds are charged once per quantity), then apply authorized staff `discountPercent`, configured business `taxPercent` to the post-discount subtotal, and configured `depositPercent` to the tax-inclusive total. Percentages allow up to two decimal places. Use exact integer arithmetic to round monetary amounts to the nearest kobo (minimum deposit rounds up); snapshot percentages and amounts. Public callers cannot submit discounts. Ignore client-supplied prices and totals.
5. **Check conflicts:** rentals must have enough non-damaged/non-missing units for overlapping intervals; venues must be open and not double-booked; venue capacity must cover guest count.
6. **Create atomically:** write customer link, booking, line snapshots, audit record, and a deduplicated notification outbox event in one transaction.
7. **Confirm atomically:** require recorded net payment to meet the snapshotted required deposit, recheck stock/venue conflicts under appropriate row/advisory locks, create allocations, change `pending` to `confirmed`, and append the notification outbox event together.
8. **Update totals:** after accepted line changes or payments/refunds, recalculate server-derived totals and balances; append audit events.
9. **Notify:** booking create/update/confirm/cancel/complete events are persisted to the outbox within their transactions. A pluggable worker claims queued events with a lease and retry schedule; delivery failures are retained and eventually marked failed. No email/SMS/WhatsApp provider is configured yet.

`Idempotency-Key` is required for public and admin booking creation and must be 16-128 characters. A repeated key with an identical body returns the original booking/request (HTTP 200); using the same key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`. Public retries also return the original access token. The booking status endpoint requires the token in `X-Booking-Access-Token`.

`POST /bookings/{id}/cancellation-preview` returns the booking version, policy cutoff, applicable refund percentage, and estimated eligible refund. Confirm with `POST /bookings/{id}/cancel` using `{ "reason": "...", "version": 3, "confirm": true }`, with the version returned by the preview. The server rechecks version, state, dispatch, and policy transactionally; stale previews return `409 VERSION_CONFLICT`. Cancellation returns the impact snapshot and never issues a refund. Record an actual refund through the separate finance workflow; never discard captured payment records.

## 8. Suggested persistence model

At minimum, persist these tables/collections with foreign keys and business scoping:

| Entity | Important data |
|---|---|
| `businesses` | Name, address, currency, timezone, business settings. |
| `users` | Normalized email, password hash or identity-provider reference, security timestamps. |
| `business_memberships` | Business/user relation, role, active/invited state. |
| `invitations` | Hashed invitation tokens, expiry, and acceptance timestamps. |
| `customers` | Contact fields, type, business ID, archive timestamps. |
| `listings` | Public/admin catalogue fields, kind, price, publication state. |
| `inventory_items` / `stock_movements` | Stock counts and immutable adjustment history. |
| `venues` / `venue_blackouts` | Capacity, rate, status, reservation restrictions. |
| `bookings` / `booking_lines` | Customer, status, event interval, totals and immutable quoted lines. |
| `inventory_allocations` | Booking, inventory item, quantity, interval, allocation state. |
| `payments` / `refunds` | Immutable payment/refund records and provider references. |
| `dispatches` / `dispatch_checklist_events` | Delivery, assignment, checklist, actual quantity reconciliation. |
| `enquiries` | Public contact request, source, status, assigned staff, conversion link. |
| `audit_events` | Actor, business, action, resource and redacted change details. |
| `notification_outbox` | Notification type, destination, retry state, delivery metadata. |

Use database constraints for unique `(businessId, sku)`, valid non-negative money/stock, and unique idempotency keys within a caller/business scope. Model inventory allocations and venue intervals so overlapping confirmed reservations can be checked transactionally. Keep an audit record for status, price, stock, payment, refund, permission, and settings changes. MongoDB transactions require a replica set (including local development); a standalone MongoDB server cannot run booking creation/confirmation transactions.

## 9. Validation and operational requirements

- Validate request bodies against explicit schemas; reject unknown enum values and malformed IDs.
- Normalize email, phone, and search input consistently. Do not log passwords, access tokens, reset tokens, payment secrets, or unnecessary customer PII.
- Enforce per-role permissions, business scoping, rate limits, request-size limits, and CORS allowlists.
- Use TLS, secure password hashing (for example Argon2id), short-lived signed access tokens, managed signing secrets, and auth-version checks for account-wide token invalidation.
- Escape/sanitize user-authored content wherever rendered; avoid interpreting notes as HTML.
- Apply idempotency to public request creation, payment provider events, and retryable commands.
- Use transactions/locking for booking confirmation, stock allocation, stock adjustments, payment/refund balance updates, and enquiry conversion.
- Emit structured logs with `requestId`; return that ID in all error responses. Monitor failed jobs, payment webhook signature failures, notification retries, and availability conflicts.
- Back up business data and test restore procedures. Define retention and deletion policies for customer and payment data before production launch.

## 10. Frontend integration notes

The admin app currently calls only an in-memory Axios adapter for `/bookings` and `/inventory`; other records/actions are mutated in React state. The customer storefront calls an in-memory adapter for `/catalog`; its bag and enquiry confirmation are client state only. These adapters should be replaced by a shared Axios client configured with the deployed API base URL, bearer-token authorization, request IDs, and centralized error handling.

Suggested integration order:

1. Authentication and `/auth/me`.
2. Public listings and availability.
3. Customers and bookings, including pending/confirm/cancel flows.
4. Inventory, venues, services, and calendar.
5. Payment records and dispatch/returns.
6. Staff/settings, reporting, notifications, and exports.

Keep the UI's demo mode visibly separate from production. Never display a simulated payment, booking confirmation, or local-only change as a persisted server success.
