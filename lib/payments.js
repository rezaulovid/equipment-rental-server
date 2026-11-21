import { collections, withOptionalTransaction } from "./db.js"
import { toId, toNumber } from "./normalize.js"
import { byIdFilter, idCandidates } from "./records.js"
import {
  assertStripeConfigured,
  toStripeAmount,
} from "./stripe.js"

/**
 * Payment state transitions shared by the Stripe webhook and the success-page
 * verification endpoint. Both paths use Stripe's own response as the source
 * of truth and are idempotent, so a retried webhook cannot double-credit a
 * booking.
 */

const sessionOptions = (session) => (session ? { session } : {})

function normalizeId(value) {
  return toId(value)
}

async function findPayment(session, databaseSession) {
  const paymentId = session.metadata?.paymentId
  const sessionId = session.id

  if (paymentId) {
    const doc = await collections.payments.findOne(
      byIdFilter(paymentId),
      sessionOptions(databaseSession)
    )
    if (doc) return doc
  }

  if (sessionId) {
    return collections.payments.findOne(
      { stripeSessionId: sessionId },
      sessionOptions(databaseSession)
    )
  }

  return null
}

async function findBooking(session, payment, databaseSession) {
  const bookingId = session.metadata?.bookingId ?? payment?.bookingId
  if (!bookingId) return null

  return collections.bookings.findOne(
    byIdFilter(bookingId),
    sessionOptions(databaseSession)
  )
}

/**
 * Marks a verified Stripe Checkout session as paid.
 *
 * `session` must come from Stripe (webhook event or `sessions.retrieve`), not
 * from the browser. The amount is compared against the amount stored in the
 * payments and bookings collections before anything is updated.
 */
async function markCheckoutPaidInTransaction(session, databaseSession) {
  if (!session || session.payment_status !== "paid") {
    return { updated: false, reason: "not_paid" }
  }

  const payment = await findPayment(session, databaseSession)
  if (!payment) {
    return { updated: false, reason: "payment_not_found" }
  }

  const booking = await findBooking(session, payment, databaseSession)
  if (!booking) {
    return { updated: false, reason: "booking_not_found" }
  }

  const sessionBookingId =
    session.metadata?.bookingId ?? session.client_reference_id
  if (
    sessionBookingId &&
    payment.bookingId &&
    normalizeId(sessionBookingId) !== normalizeId(payment.bookingId)
  ) {
    return { updated: false, reason: "booking_mismatch" }
  }

  if (
    session.metadata?.customerId &&
    payment.customerId &&
    normalizeId(session.metadata.customerId) !== normalizeId(payment.customerId)
  ) {
    return { updated: false, reason: "customer_mismatch" }
  }

  if (
    session.currency &&
    payment.currency &&
    String(session.currency).toLowerCase() !==
      String(payment.currency).toLowerCase()
  ) {
    return { updated: false, reason: "currency_mismatch" }
  }

  const expectedAmount = toStripeAmount(
    toNumber(payment.amount, booking.totalAmount)
  )
  const paidAmount = toNumber(session.amount_total, -1)

  if (expectedAmount !== paidAmount) {
    console.error(
      `[payments] amount mismatch for booking ${toId(booking._id)}: expected ${expectedAmount}, received ${paidAmount}`
    )
    return { updated: false, reason: "amount_mismatch" }
  }

  const now = new Date()
  const transactionId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? session.id

  // Idempotent update: only a not-yet-paid payment is written, so repeated
  // webhook deliveries keep the original transaction record intact.
  await collections.payments.updateOne(
    { _id: payment._id, status: { $ne: "paid" } },
    {
      $set: {
        status: "paid",
        transactionId,
        stripeSessionId: session.id,
        receiptUrl:
          session.payment_intent && typeof session.payment_intent === "object"
            ? (session.payment_intent.latest_charge?.receipt_url ?? "")
            : (payment.receiptUrl ?? ""),
        paidAt: now,
        updatedAt: now,
      },
    },
    sessionOptions(databaseSession)
  )

  const currentStatus = String(
    booking.bookingStatus ?? booking.status ?? "pending"
  ).toLowerCase()

  const bookingPatch = {
    paymentStatus: "paid",
    updatedAt: now,
  }

  // A paid booking becomes active. Already completed/active bookings keep
  // their lifecycle state.
  if (currentStatus === "pending" || currentStatus === "cancelled") {
    bookingPatch.bookingStatus = "active"
  }

  await collections.bookings.updateOne(
    { _id: booking._id },
    { $set: bookingPatch },
    sessionOptions(databaseSession)
  )

  // Any earlier checkout attempt for the same booking is superseded.
  await collections.payments.updateMany(
    {
      bookingId: { $in: [toId(booking._id), ...idCandidates(booking._id)] },
      _id: { $ne: payment._id },
      status: { $in: ["pending", "failed"] },
    },
    { $set: { status: "failed", failureReason: "superseded", updatedAt: now } },
    sessionOptions(databaseSession)
  )

  return {
    updated: true,
    bookingId: toId(booking._id),
    paymentId: toId(payment._id),
  }
}

export async function markCheckoutPaid(session, databaseSession) {
  if (databaseSession !== undefined) {
    return markCheckoutPaidInTransaction(session, databaseSession)
  }
  return withOptionalTransaction((transactionSession) =>
    markCheckoutPaidInTransaction(session, transactionSession)
  )
}

/**
 * Records a failed, expired or cancelled checkout. Paid records are never
 * downgraded, which protects against out-of-order webhook delivery.
 */
async function markCheckoutFailedInTransaction(
  session,
  reason = "cancelled",
  { cancelBooking = true } = {},
  databaseSession
) {
  if (!session) return { updated: false }

  const payment = await findPayment(session, databaseSession)
  if (!payment) return { updated: false, reason: "payment_not_found" }
  if (payment.status === "paid") return { updated: false, reason: "already_paid" }

  const booking = await findBooking(session, payment, databaseSession)
  if (!booking) return { updated: false, reason: "booking_not_found" }
  const now = new Date()

  await collections.payments.updateOne(
    { _id: payment._id, status: { $ne: "paid" } },
    {
      $set: {
        status: "failed",
        failureReason: reason,
        stripeSessionId: session.id,
        updatedAt: now,
      },
    },
    sessionOptions(databaseSession)
  )

  const currentStatus = String(
    booking.bookingStatus ?? booking.status ?? "pending"
  ).toLowerCase()

  await collections.bookings.updateOne(
    { _id: booking._id, paymentStatus: { $ne: "paid" } },
    {
      $set: {
        paymentStatus: "failed",
        ...(cancelBooking &&
        currentStatus === "pending" &&
        reason !== "expired" &&
        reason !== "async_payment_failed"
          ? { bookingStatus: "cancelled" }
          : {}),
        updatedAt: now,
      },
    },
    sessionOptions(databaseSession)
  )

  return { updated: true }
}

export async function markCheckoutFailed(
  session,
  reason = "cancelled",
  options = {},
  databaseSession
) {
  const operation = (transactionSession) =>
    markCheckoutFailedInTransaction(
      session,
      reason,
      options,
      transactionSession
    )
  if (databaseSession !== undefined) return operation(databaseSession)
  return withOptionalTransaction(operation)
}

export function sessionBelongsToCustomer(session, customerId) {
  const owner = session?.metadata?.customerId ?? session?.client_reference_id
  return Boolean(owner) && normalizeId(owner) === normalizeId(customerId)
}

export async function expireCheckoutForCustomer(
  sessionId,
  customerId,
  reason = "cancelled"
) {
  const stripe = assertStripeConfigured()
  let session = await stripe.checkout.sessions.retrieve(sessionId)

  if (!sessionBelongsToCustomer(session, customerId)) {
    return { forbidden: true, cancelled: false, paid: false }
  }

  if (session.payment_status === "paid") {
    await markCheckoutPaid(session)
    return { cancelled: false, paid: true }
  }

  if (session.status === "open") {
    try {
      session = await stripe.checkout.sessions.expire(session.id)
    } catch (error) {
      const current = await stripe.checkout.sessions.retrieve(session.id)
      if (current.status === "open") throw error
      session = current
    }
  }

  if (session.payment_status === "paid") {
    await markCheckoutPaid(session)
    return { cancelled: false, paid: true }
  }

  if (session.status === "expired") {
    await markCheckoutFailed(session, reason, {
      cancelBooking: reason === "cancelled",
    })
    return { cancelled: true, paid: false }
  }

  return { cancelled: false, paid: false, processing: true }
}

/**
 * A card can fail before the Checkout session is completed. The booking stays
 * pending so the customer can retry inside the hosted page, while the failed
 * attempt is preserved in the payments collection.
 */
async function markPaymentIntentFailedInTransaction(intent, databaseSession) {
  const paymentId = intent?.metadata?.paymentId
  if (!paymentId) return { updated: false, reason: "missing_metadata" }

  const payment = await collections.payments.findOne(
    byIdFilter(paymentId),
    sessionOptions(databaseSession)
  )
  if (!payment || payment.status === "paid") {
    return { updated: false, reason: payment ? "already_paid" : "payment_not_found" }
  }

  const booking = await collections.bookings.findOne(
    byIdFilter(payment.bookingId),
    sessionOptions(databaseSession)
  )
  if (!booking) return { updated: false, reason: "booking_not_found" }

  const now = new Date()

  await collections.payments.updateOne(
    { _id: payment._id, status: { $ne: "paid" } },
    {
      $set: {
        status: "failed",
        failureReason: intent.last_payment_error?.message ?? "payment_failed",
        updatedAt: now,
      },
    },
    sessionOptions(databaseSession)
  )

  await collections.bookings.updateOne(
    { _id: booking._id, paymentStatus: { $ne: "paid" } },
    { $set: { paymentStatus: "failed", updatedAt: now } },
    sessionOptions(databaseSession)
  )

  return { updated: true }
}

export async function markPaymentIntentFailed(intent, databaseSession) {
  if (databaseSession !== undefined) {
    return markPaymentIntentFailedInTransaction(intent, databaseSession)
  }
  return withOptionalTransaction((transactionSession) =>
    markPaymentIntentFailedInTransaction(intent, transactionSession)
  )
}
