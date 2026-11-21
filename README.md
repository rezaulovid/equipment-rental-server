# RentPro Equipment Rental API

Express and MongoDB API for the RentPro equipment rental marketplace. It
provides authenticated customer, owner, and admin operations; approved
equipment search; inventory-aware bookings; Stripe Checkout/webhooks; reviews;
and dashboard analytics.

## Requirements

- Node.js 20+
- MongoDB
- A running RentPro client with a matching BetterAuth deployment
- Stripe credentials to enable Checkout and webhook processing

## Configuration

Set these variables in the server environment. Keep secret values out of source
control.

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB connection string. Alternatively configure `DB_USER` and `DB_PASSWORD`. |
| `DB_NAME` | MongoDB database name; defaults to `rentalAdmindb`. |
| `BETTER_AUTH_URL` | BetterAuth issuer URL used to verify API access tokens. |
| `CLIENT_URL` | Client origin(s) allowed by CORS and the origin used for Checkout redirects. |
| `STRIPE_SECRET_KEY` | Server-only Stripe secret key. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret. |
| `STRIPE_CURRENCY` | Checkout currency; defaults to `usd`. |
| `PORT` | HTTP port; defaults to `5000`. |

`CLIENT_URL` may contain comma-separated allowed origins for CORS. Configure a
single client origin for Stripe redirect URLs.

## Run locally

```bash
npm install
npm run dev
```

The API listens on `http://localhost:5000` by default. `GET /health` reports
process health. The API connects to MongoDB and creates required indexes during
startup.

## Main endpoints

- `/api/equipment` — approved public catalogue, search, filters, and optional `page`/`limit` pagination. Availability filters accept `startDate`, `endDate`, and `quantity`.
- `/api/favorites` — customer favorites
- `/api/bookings` — customer rental and checkout initiation
- `/api/payments` — payment confirmation, cancellation, and Stripe webhook
- `/api/reviews` — verified customer reviews; public retrieval can be scoped with `equipmentId` and paginated with `page`/`limit`
- `/api/customer` — customer profile, rentals, and payments
- `/api/owner` — owner equipment, rentals, and analytics
- `/api/admin` — admin management and platform analytics
- `/api/admin/users/:id` — retrieve normalized details for one user (admin only)

Customer, owner, and admin rental lists accept optional `page` and `limit`
query parameters while retaining their existing array response shape.
Booking creation accepts an optional `Idempotency-Key` header. Reusing the key
with different rental details returns `409` rather than replaying another
booking.

Authentication tokens are verified against the BetterAuth JWKS endpoint at
`{BETTER_AUTH_URL}/api/auth/jwks`. API roles are loaded from MongoDB for each
request.

## Utility scripts

```bash
npm run set-role -- user@example.com owner
npm run seed
```

Use the role script only for an existing account and with a trusted database
configuration. The demo seed is intended for development environments.
