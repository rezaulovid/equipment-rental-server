import {
  assertStripeConfigured,
  clientUrl,
  stripeCurrency,
  toStripeAmount,
} from "./stripe.js"
import { formatRentalPeriod } from "./pricing.js"

/**
 * Creates a Stripe Checkout session for a booking that already exists in the
 * database. The amount passed in must have been recalculated from trusted
 * equipment data by the caller.
 */
export async function createBookingCheckout({
  bookingId,
  paymentId,
  customerId,
  customerEmail,
  equipmentName,
  amount,
  durationDays,
  quantity,
  rentalType,
}) {
  const stripe = assertStripeConfigured()
  const unitAmount = toStripeAmount(amount)

  if (!Number.isInteger(unitAmount) || unitAmount <= 0) {
    const error = new Error("The payable amount is invalid.")
    error.status = 400
    throw error
  }

  const period = formatRentalPeriod(rentalType)

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: stripeCurrency,
          unit_amount: unitAmount,
          product_data: {
            name: `${equipmentName} rental`,
            description: `${quantity} × ${durationDays} day${
              durationDays === 1 ? "" : "s"
            } (${period} rate)`,
          },
        },
      },
    ],
    customer_email: customerEmail || undefined,
    client_reference_id: String(bookingId),
    metadata: {
      bookingId: String(bookingId),
      paymentId: String(paymentId),
      customerId: String(customerId),
    },
    payment_intent_data: {
      metadata: {
        bookingId: String(bookingId),
        paymentId: String(paymentId),
        customerId: String(customerId),
      },
    },
    success_url: `${clientUrl}/dashboard/customer/payments/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${clientUrl}/dashboard/customer/payments/cancelled?booking_id=${encodeURIComponent(
      String(bookingId)
    )}`,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  })

  return session
}
