import { Router } from "express"

import { collections, withOptionalTransaction } from "../lib/db.js"
import {
  markCheckoutFailed,
  markCheckoutPaid,
  markPaymentIntentFailed,
  expireCheckoutForCustomer,
  sessionBelongsToCustomer,
} from "../lib/payments.js"
import { stripe } from "../lib/stripe.js"
import { verifyRenter, verifyToken } from "../middleware/auth.js"

const router = Router()

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data })

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message })

const sessionOptions = (session) => (session ? { session } : {})

/**
 * Verifies a Checkout session with Stripe after the success redirect. This is
 * a server-to-server lookup, so the browser cannot fake a payment. The webhook
 * remains the primary confirmation path; this just makes the success page
 * resilient when the webhook is a few seconds late.
 */
router.get("/session/:sessionId", verifyToken, verifyRenter, async (req, res, next) => {
  try {
    if (!stripe) {
      return fail(res, 503, "Online payments are not configured yet.")
    }

    const session = await stripe.checkout.sessions.retrieve(
      req.params.sessionId,
      { expand: ["payment_intent"] }
    )

    if (!sessionBelongsToCustomer(session, req.user.id)) {
      return fail(res, 403, "This payment does not belong to your account.")
    }

    let result = { updated: false }

    if (session.payment_status === "paid") {
      result = await markCheckoutPaid(session)
    } else if (session.status === "expired") {
      result = await markCheckoutFailed(session, "expired", {
        cancelBooking: false,
      })
    }

    const payment = await collections.payments.findOne({
      stripeSessionId: session.id,
    })

    return ok(res, {
      status: session.payment_status,
      sessionStatus: session.status,
      amount: session.amount_total ? session.amount_total / 100 : 0,
      currency: String(session.currency ?? "usd").toUpperCase(),
      bookingId: session.metadata?.bookingId ?? "",
      paymentStatus: payment?.status ?? "pending",
      updated: result.updated,
    })
  } catch (error) {
    return next(error)
  }
})

/**
 * Stripe webhook. It must receive the raw request body so the signature can be
 * verified with the endpoint secret. Never trust event data from the client.
 */
export async function handleStripeWebhook(req, res) {
  if (!stripe) {
    return res
      .status(503)
      .json({ success: false, message: "Stripe is not configured." })
  }

  const signature = req.headers["stripe-signature"]
  const secret = process.env.STRIPE_WEBHOOK_SECRET

  if (!signature || !secret) {
    return res
      .status(400)
      .json({ success: false, message: "Missing Stripe webhook signature." })
  }

  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, secret)
  } catch (error) {
    console.error("[stripe] webhook signature verification failed:", error.message)
    return res
      .status(400)
      .json({ success: false, message: "Invalid webhook signature." })
  }

  try {
    const result = await withOptionalTransaction(async (databaseSession) => {
      const alreadyProcessed = await collections.webhookEvents.findOne(
        { eventId: event.id },
        sessionOptions(databaseSession)
      )
      if (alreadyProcessed) return { duplicate: true }

      let outcome
      switch (event.type) {
        case "checkout.session.completed":
          if (event.data.object.payment_status === "paid") {
            outcome = await markCheckoutPaid(event.data.object, databaseSession)
          }
          break

        case "checkout.session.async_payment_succeeded":
          outcome = await markCheckoutPaid(event.data.object, databaseSession)
          break

        case "checkout.session.async_payment_failed":
          outcome = await markCheckoutFailed(
            event.data.object,
            "async_payment_failed",
            { cancelBooking: false },
            databaseSession
          )
          break

        case "checkout.session.expired":
          outcome = await markCheckoutFailed(
            event.data.object,
            "expired",
            { cancelBooking: false },
            databaseSession
          )
          break

        case "payment_intent.payment_failed":
          outcome = await markPaymentIntentFailed(
            event.data.object,
            databaseSession
          )
          break

        default:
          break
      }

      if (
        outcome?.reason &&
        !["already_paid", "missing_metadata"].includes(outcome.reason)
      ) {
        throw new Error(
          `Unable to apply Stripe event ${event.id}: ${outcome.reason}`
        )
      }

      await collections.webhookEvents.insertOne(
        {
          eventId: event.id,
          type: event.type,
          receivedAt: new Date(),
        },
        sessionOptions(databaseSession)
      )

      return { duplicate: false }
    })

    return res.json({ received: true, ...result })
  } catch (error) {
    if (error?.code === 11000) {
      return res.json({ received: true, duplicate: true })
    }

    console.error("[stripe] webhook processing failed:", error)
    return res
      .status(500)
      .json({ success: false, message: "Webhook processing failed." })
  }
}

/**
 * A customer can release an unpaid booking when they leave Checkout. Stripe's
 * session expiry webhook covers the case where they simply close the tab.
 */
router.post("/cancel", verifyToken, verifyRenter, async (req, res, next) => {
  try {
    const sessionId = String(req.body?.sessionId ?? "").trim()
    if (!sessionId) return fail(res, 400, "A checkout session is required.")

    if (!stripe) return fail(res, 503, "Online payments are not configured yet.")

    const result = await expireCheckoutForCustomer(
      sessionId,
      req.user.id,
      "cancelled"
    )

    if (result.forbidden) {
      return fail(res, 403, "This payment does not belong to your account.")
    }

    if (result.paid) {
      return fail(res, 409, "This checkout has already been paid.")
    }

    if (!result.cancelled) {
      return fail(
        res,
        409,
        "This checkout is still processing and cannot be cancelled yet."
      )
    }

    return ok(res, { cancelled: true })
  } catch (error) {
    return next(error)
  }
})

export default router
