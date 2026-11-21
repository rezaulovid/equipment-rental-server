import { Router } from "express"
import { ObjectId } from "mongodb"

import { collections } from "../lib/db.js"
import { createBookingCheckout } from "../lib/checkout.js"
import {
  bookingRequestFingerprint,
  parseIdempotencyKey,
} from "../lib/idempotency.js"
import {
  calculateAvailableQuantity,
  toId,
  toNumber,
} from "../lib/normalize.js"
import {
  acquireEquipmentReservationLock,
  customerOwnershipFilter,
  equipmentByIdFilter,
  idCandidates,
  inventoryHoldFilter,
  releaseEquipmentReservationLock,
  startEquipmentReservationLockHeartbeat,
} from "../lib/records.js"
import { expireCheckoutForCustomer } from "../lib/payments.js"
import {
  calculateRentalTotal,
  normalizeRentalType,
  validateRentalDates,
} from "../lib/pricing.js"
import { stripeCurrency } from "../lib/stripe.js"
import { verifyRenter, verifyToken } from "../middleware/auth.js"

const router = Router()

router.use(verifyToken, verifyRenter)

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data })

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message })

function validateBookingInput(body) {
  const equipmentId = String(body.equipmentId ?? "").trim()
  if (!ObjectId.isValid(equipmentId)) {
    return { error: "Choose a valid equipment item." }
  }

  const dates = validateRentalDates(body.startDate, body.endDate)
  if (!dates.valid) return { error: dates.message }

  const quantity = Number(body.quantity)
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { error: "Quantity must be a whole number of at least 1." }
  }

  const contactNumber = String(body.contactNumber ?? "").trim()
  if (contactNumber.length < 6 || contactNumber.length > 30) {
    return { error: "Enter a valid contact number." }
  }
  if (!/^[+\d()\s.-]{6,30}$/.test(contactNumber)) {
    return { error: "Enter a valid contact number." }
  }

  const deliveryAddress = String(body.deliveryAddress ?? "").trim()
  if (deliveryAddress.length < 5 || deliveryAddress.length > 200) {
    return { error: "Delivery address must be between 5 and 200 characters." }
  }

  const notes = String(body.notes ?? "").trim()
  if (notes.length > 500) {
    return { error: "Additional notes must be at most 500 characters." }
  }

  return {
    equipmentId,
    startDate: dates.startDate,
    endDate: dates.endDate,
    quantity,
    contactNumber,
    deliveryAddress,
    notes,
  }
}

/** Finds the peak concurrent reservation during the requested interval. */
async function equipmentAvailability(
  equipmentId,
  totalQuantity,
  startDate,
  endDate,
  ignoreId
) {
  const filter = {
    ...inventoryHoldFilter(equipmentId),
    startDate: { $lt: endDate },
    endDate: { $gt: startDate },
  }

  if (ignoreId) {
    filter._id = { $ne: ignoreId }
  }

  const overlapping = await collections.bookings.find(filter).toArray()
  return calculateAvailableQuantity(
    totalQuantity,
    overlapping,
    startDate,
    endDate
  )
}

function equipmentQuantity(equipment) {
  return toNumber(equipment.availableQuantity ?? equipment.quantity, 0)
}

async function createPendingPayment(bookingId, customerId, amount, ownerId) {
  const now = new Date()
  const result = await collections.payments.insertOne({
    bookingId: toId(bookingId),
    customerId,
    ownerId: toId(ownerId),
    amount,
    currency: stripeCurrency,
    status: "pending",
    method: "stripe",
    transactionId: "",
    createdAt: now,
    updatedAt: now,
  })

  return result.insertedId
}

async function replayIdempotentBooking(res, booking, fingerprint) {
  if (booking.idempotencyFingerprint !== fingerprint) {
    return fail(
      res,
      409,
      "This idempotency key was already used for a different booking request."
    )
  }

  const payment = await collections.payments.findOne(
    {
      bookingId: { $in: [toId(booking._id), ...idCandidates(booking._id)] },
    },
    { sort: { createdAt: -1 } }
  )

  if (!payment?.checkoutUrl) {
    return fail(res, 409, "This booking request is still being processed.")
  }

  return ok(
    res,
    {
      bookingId: toId(booking._id),
      paymentId: toId(payment._id),
      checkoutUrl: payment.checkoutUrl,
      amount: toNumber(payment.amount ?? booking.totalAmount),
      currency: String(payment.currency ?? booking.currency ?? stripeCurrency).toUpperCase(),
    },
    200
  )
}

/**
 * Creates a pending booking and its Stripe Checkout session. The client only
 * sends rental details — every amount is calculated here from the equipment
 * document, and Stripe is the only party that can later confirm payment.
 */
router.post("/", async (req, res, next) => {
  let idempotencyKey = null
  let fingerprint = null
  try {
    const parsedKey = parseIdempotencyKey(req.get("Idempotency-Key"))
    if (parsedKey.error) return fail(res, 400, parsedKey.error)
    idempotencyKey = parsedKey.key

    const input = validateBookingInput(req.body ?? {})
    if (input.error) return fail(res, 400, input.error)
    if (idempotencyKey) fingerprint = bookingRequestFingerprint(input)

    if (idempotencyKey) {
      const existing = await collections.bookings.findOne({
        customerId: req.user.id,
        idempotencyKey,
      })
      if (existing) {
        return replayIdempotentBooking(res, existing, fingerprint)
      }
    }

    let equipment = await collections.equipment.findOne(
      equipmentByIdFilter(input.equipmentId)
    )

    if (!equipment || String(equipment.status).toLowerCase() !== "approved") {
      return fail(res, 404, "This equipment is not available to rent.")
    }

    const reservationEquipmentId = equipment._id
    const lockToken = await acquireEquipmentReservationLock(reservationEquipmentId)
    if (!lockToken) {
      return fail(
        res,
        409,
        "Another booking is being created for this equipment. Please try again."
      )
    }
    const lockHeartbeat = startEquipmentReservationLockHeartbeat(
      reservationEquipmentId,
      lockToken
    )

    let pricing
    let bookingDoc
    let inserted
    let paymentId

    try {
      equipment = await collections.equipment.findOne({ _id: equipment._id })
      if (!equipment || String(equipment.status).toLowerCase() !== "approved") {
        return fail(res, 404, "This equipment is not available to rent.")
      }

      const totalQuantity = equipmentQuantity(equipment)
      if (totalQuantity < 1) {
        return fail(res, 409, "This equipment is currently unavailable.")
      }

      if (input.quantity > totalQuantity) {
        return fail(
          res,
          400,
          `Only ${totalQuantity} unit${totalQuantity === 1 ? "" : "s"} of this equipment exist.`
        )
      }

      const { availableQuantity: available } = await equipmentAvailability(
        equipment._id,
        totalQuantity,
        input.startDate,
        input.endDate
      )

      if (input.quantity > available) {
        return fail(
          res,
          409,
          available === 0
            ? "This equipment is fully booked for the selected dates."
            : `Only ${available} unit${available === 1 ? "" : "s"} available for the selected dates.`
        )
      }

      await lockHeartbeat.assertOwned()

      pricing = calculateRentalTotal({
        rentalPrice: equipment.rentalPrice ?? equipment.price,
        rentalType: equipment.rentalType ?? equipment.rentalPeriod,
        startDate: input.startDate,
        endDate: input.endDate,
        quantity: input.quantity,
      })

      if (pricing.totalAmount <= 0) {
        return fail(res, 400, "The rental amount could not be calculated.")
      }

      const now = new Date()
      bookingDoc = {
        equipmentId: toId(equipment._id),
        equipmentName: equipment.name ?? "Equipment",
        equipmentImage: equipment.image ?? "",
        equipmentCategory: equipment.category ?? "",
        customerId: req.user.id,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(fingerprint ? { idempotencyFingerprint: fingerprint } : {}),
        customerName: req.user.name,
        customerEmail: req.user.email,
        ownerId: toId(equipment.ownerId),
        ownerName: equipment.ownerName ?? "",
        ownerEmail: equipment.ownerEmail ?? "",
        startDate: input.startDate,
        endDate: input.endDate,
        durationDays: pricing.durationDays,
        billableUnits: pricing.billableUnits,
        rentalType: normalizeRentalType(
          equipment.rentalType ?? equipment.rentalPeriod
        ),
        unitPrice: pricing.unitPrice,
        quantity: input.quantity,
        contactNumber: input.contactNumber,
        deliveryAddress: input.deliveryAddress,
        notes: input.notes,
        totalAmount: pricing.totalAmount,
        currency: stripeCurrency,
        paymentStatus: "pending",
        bookingStatus: "pending",
        checkoutExpiresAt: new Date(now.getTime() + 35 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      }

      inserted = await collections.bookings.insertOne(bookingDoc)
      await lockHeartbeat.assertOwned()
      paymentId = await createPendingPayment(
        inserted.insertedId,
        req.user.id,
        pricing.totalAmount,
        equipment.ownerId
      )
    } catch (error) {
      if (inserted?.insertedId && !paymentId) {
        await collections.bookings.updateOne(
          { _id: inserted.insertedId },
          {
            $set: {
              bookingStatus: "cancelled",
              paymentStatus: "failed",
              updatedAt: new Date(),
            },
          }
        )
      }

      throw error
    } finally {
      await lockHeartbeat.stop()
      await releaseEquipmentReservationLock(reservationEquipmentId, lockToken)
    }

    const bookingId = inserted.insertedId

    try {
      const session = await createBookingCheckout({
        bookingId: toId(bookingId),
        paymentId: toId(paymentId),
        customerId: req.user.id,
        customerEmail: req.user.email,
        equipmentName: bookingDoc.equipmentName,
        amount: pricing.totalAmount,
        durationDays: pricing.durationDays,
        quantity: input.quantity,
        rentalType: bookingDoc.rentalType,
      })

      await Promise.all([
        collections.payments.updateOne(
          { _id: paymentId },
          {
            $set: {
              stripeSessionId: session.id,
              checkoutUrl: session.url,
              updatedAt: new Date(),
            },
          }
        ),
        collections.bookings.updateOne(
          { _id: bookingId },
          { $set: { stripeSessionId: session.id, updatedAt: new Date() } }
        ),
      ])

      return ok(
        res,
        {
          bookingId: toId(bookingId),
          paymentId: toId(paymentId),
          checkoutUrl: session.url,
          amount: pricing.totalAmount,
          currency: stripeCurrency,
        },
        201
      )
    } catch (error) {
      // Keep the transaction record, but release the pending booking so the
      // customer can correct the details and try again.
      await Promise.all([
        collections.payments.updateOne(
          { _id: paymentId },
          {
            $set: {
              status: "failed",
              failureReason: error.message,
              updatedAt: new Date(),
            },
          }
        ),
        collections.bookings.updateOne(
          { _id: bookingId },
          {
            $set: {
              paymentStatus: "failed",
              updatedAt: new Date(),
            },
          }
        ),
      ])

      error.status = error.status ?? 502
      throw error
    }
  } catch (error) {
    if (error?.code === 11000 && idempotencyKey) {
      const existing = await collections.bookings.findOne({
        customerId: req.user.id,
        idempotencyKey,
      })
      if (existing) return replayIdempotentBooking(res, existing, fingerprint)
    }
    return next(error)
  }
})

/** Starts a fresh Stripe Checkout attempt for an existing pending booking. */
router.post("/:id/checkout", async (req, res, next) => {
  try {
    const booking = await collections.bookings.findOne({
      ...customerOwnershipFilter(req.user.id),
      ...(ObjectId.isValid(req.params.id)
        ? { _id: { $in: [req.params.id, new ObjectId(req.params.id)] } }
        : { _id: req.params.id }),
    })

    if (!booking) return fail(res, 404, "Rental not found.")
    if (String(booking.paymentStatus) === "paid") {
      return fail(res, 400, "This rental has already been paid.")
    }
    if (String(booking.bookingStatus ?? "pending") !== "pending") {
      return fail(res, 400, "This rental can no longer be paid.")
    }

    const equipment = await collections.equipment.findOne(
      equipmentByIdFilter(booking.equipmentId)
    )

    if (!equipment) {
      return fail(res, 404, "The equipment for this rental no longer exists.")
    }

    const paymentAttempts = await collections.payments
      .find({
        bookingId: {
          $in: [toId(booking._id), ...idCandidates(booking._id)],
        },
        status: { $in: ["pending", "failed"] },
      })
      .toArray()

    for (const attempt of paymentAttempts) {
      if (!attempt.stripeSessionId) continue

      const result = await expireCheckoutForCustomer(
        attempt.stripeSessionId,
        req.user.id,
        "superseded"
      )

      if (result.forbidden) {
        return fail(res, 403, "This checkout does not belong to your account.")
      }
      if (result.paid) {
        return fail(res, 409, "A previous checkout has already been paid.")
      }
      if (!result.cancelled) {
        return fail(
          res,
          409,
          "A previous checkout is still processing. Try again after its status is confirmed."
        )
      }
    }

    const { availableQuantity: available } = await equipmentAvailability(
      equipment._id,
      equipmentQuantity(equipment),
      booking.startDate,
      booking.endDate,
      booking._id
    )

    if (toNumber(booking.quantity, 1) > available) {
      return fail(
        res,
        409,
        "There is no longer enough equipment available for these dates."
      )
    }

    const pricing = calculateRentalTotal({
      rentalPrice: equipment.rentalPrice ?? equipment.price,
      rentalType: equipment.rentalType ?? equipment.rentalPeriod,
      startDate: booking.startDate,
      endDate: booking.endDate,
      quantity: booking.quantity,
    })

    const now = new Date()

    await collections.bookings.updateOne(
      { _id: booking._id },
      {
        $set: {
          totalAmount: pricing.totalAmount,
          durationDays: pricing.durationDays,
          billableUnits: pricing.billableUnits,
          unitPrice: pricing.unitPrice,
          rentalType: normalizeRentalType(
            equipment.rentalType ?? equipment.rentalPeriod
          ),
          paymentStatus: "pending",
          updatedAt: now,
        },
      }
    )

    await collections.payments.updateMany(
      {
        bookingId: { $in: [toId(booking._id), ...idCandidates(booking._id)] },
        status: { $in: ["pending", "failed"] },
      },
      { $set: { status: "failed", failureReason: "superseded", updatedAt: now } }
    )

    const paymentId = await createPendingPayment(
      booking._id,
      req.user.id,
      pricing.totalAmount,
      booking.ownerId ?? equipment.ownerId
    )

    try {
      const session = await createBookingCheckout({
        bookingId: toId(booking._id),
        paymentId: toId(paymentId),
        customerId: req.user.id,
        customerEmail: req.user.email,
        equipmentName: booking.equipmentName,
        amount: pricing.totalAmount,
        durationDays: pricing.durationDays,
        quantity: booking.quantity,
        rentalType: normalizeRentalType(
          equipment.rentalType ?? equipment.rentalPeriod
        ),
      })

      await Promise.all([
        collections.payments.updateOne(
          { _id: paymentId },
          {
            $set: {
              stripeSessionId: session.id,
              checkoutUrl: session.url,
              updatedAt: new Date(),
            },
          }
        ),
        collections.bookings.updateOne(
          { _id: booking._id },
          { $set: { stripeSessionId: session.id, updatedAt: new Date() } }
        ),
      ])

      return ok(res, {
        bookingId: toId(booking._id),
        paymentId: toId(paymentId),
        checkoutUrl: session.url,
        amount: pricing.totalAmount,
        currency: stripeCurrency,
      })
    } catch (error) {
      await Promise.all([
        collections.payments.updateOne(
          { _id: paymentId },
          {
            $set: {
              status: "failed",
              failureReason: error.message,
              updatedAt: new Date(),
            },
          }
        ),
        collections.bookings.updateOne(
          { _id: booking._id },
          { $set: { paymentStatus: "failed", updatedAt: new Date() } }
        ),
      ])

      error.status = error.status ?? 502
      throw error
    }
  } catch (error) {
    return next(error)
  }
})

/**
 * Cancels an unpaid pending booking. Paid or active rentals cannot be
 * cancelled from the customer dashboard.
 */
router.post("/:id/cancel", async (req, res, next) => {
  try {
    const booking = await collections.bookings.findOne({
      ...customerOwnershipFilter(req.user.id),
      ...(ObjectId.isValid(req.params.id)
        ? { _id: { $in: [req.params.id, new ObjectId(req.params.id)] } }
        : { _id: req.params.id }),
    })

    if (!booking) return fail(res, 404, "Rental not found.")

    const paymentStatus = String(booking.paymentStatus ?? "unpaid").toLowerCase()
    const bookingStatus = String(
      booking.bookingStatus ?? "pending"
    ).toLowerCase()

    if (paymentStatus === "paid" || ["active", "completed"].includes(bookingStatus)) {
      return fail(res, 400, "Paid or active rentals cannot be cancelled here.")
    }

    const paymentAttempts = await collections.payments
      .find({
        bookingId: {
          $in: [toId(booking._id), ...idCandidates(booking._id)],
        },
        status: { $in: ["pending", "failed"] },
      })
      .toArray()

    for (const attempt of paymentAttempts) {
      if (!attempt.stripeSessionId) continue

      const result = await expireCheckoutForCustomer(
        attempt.stripeSessionId,
        req.user.id
      )

      if (result.forbidden) {
        return fail(res, 403, "This checkout does not belong to your account.")
      }
      if (result.paid) {
        return fail(res, 400, "A paid rental cannot be cancelled here.")
      }
      if (!result.cancelled) {
        return fail(
          res,
          409,
          "A checkout is still processing. Wait for its payment status before cancelling."
        )
      }
    }

    const currentBooking = await collections.bookings.findOne({
      _id: booking._id,
    })
    if (!currentBooking) return fail(res, 404, "Rental not found.")

    const currentPaymentStatus = String(
      currentBooking?.paymentStatus ?? "unpaid"
    ).toLowerCase()
    const currentBookingStatus = String(
      currentBooking?.bookingStatus ?? currentBooking?.status ?? "pending"
    ).toLowerCase()

    if (
      currentPaymentStatus === "paid" ||
      ["active", "completed"].includes(currentBookingStatus)
    ) {
      return fail(res, 400, "Paid or active rentals cannot be cancelled here.")
    }

    if (currentBookingStatus === "cancelled") {
      return ok(res, {
        id: toId(booking._id),
        bookingStatus: "cancelled",
        alreadyCancelled: true,
      })
    }

    const now = new Date()

    const cancellation = await collections.bookings.updateOne(
      {
        _id: booking._id,
        paymentStatus: { $ne: "paid" },
        bookingStatus: "pending",
      },
      {
        $set: {
          bookingStatus: "cancelled",
          ...(paymentStatus === "pending" ? { paymentStatus: "failed" } : {}),
          updatedAt: now,
        },
      }
    )

    if (cancellation.modifiedCount !== 1) {
      return fail(
        res,
        409,
        "The rental status changed before it could be cancelled. Refresh and try again."
      )
    }

    await collections.payments.updateMany(
      {
        bookingId: { $in: [toId(booking._id)] },
        status: "pending",
      },
      { $set: { status: "failed", failureReason: "cancelled", updatedAt: now } }
    )

    return ok(res, {
      id: toId(booking._id),
      bookingStatus: "cancelled",
    })
  } catch (error) {
    return next(error)
  }
})

export default router
