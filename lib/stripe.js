import Stripe from "stripe"

/**
 * Stripe is configured through server-only environment variables. The secret
 * key is never sent to the browser — checkout URLs are created here and the
 * frontend only receives the redirect URL.
 */
const secretKey = process.env.STRIPE_SECRET_KEY?.trim()

export const stripe = secretKey ? new Stripe(secretKey) : null

export const stripeCurrency = (
  process.env.STRIPE_CURRENCY || "usd"
).toLowerCase()

export const clientUrl = (
  process.env.CLIENT_URL || "http://localhost:3000"
).replace(/\/+$/, "")

export function assertStripeConfigured() {
  if (!stripe) {
    const error = new Error(
      "Online payments are not configured yet. Add STRIPE_SECRET_KEY to the API environment."
    )
    error.status = 503
    throw error
  }

  return stripe
}

/** Converts a database amount (major units) into Stripe's minor units. */
export function toStripeAmount(amount) {
  return Math.round(Number(amount) * 100)
}
