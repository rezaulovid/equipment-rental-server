import { Router } from "express"
import { ObjectId } from "mongodb"

import { collections } from "../lib/db.js"
import {
  normalizeBooking,
  normalizePayment,
  normalizeUser,
  toId,
  toNumber,
} from "../lib/normalize.js"
import {
  byIdFilter,
  customerOwnershipFilter,
  loadBookingsMap,
  loadEquipmentMap,
} from "../lib/records.js"
import { verifyRenter, verifyToken } from "../middleware/auth.js"

const router = Router()

// The API is the security boundary: every query below is scoped to the
// authenticated customer, never to an id supplied by the browser.
router.use(verifyToken, verifyRenter)

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data })

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message })

async function customerBookings(customerId) {
  return collections.bookings
    .find(customerOwnershipFilter(customerId))
    .sort({ createdAt: -1 })
    .toArray()
}

async function serializeBookings(docs) {
  const equipmentMap = await loadEquipmentMap(
    docs.map((doc) => doc.equipmentId)
  )

  return docs.map((doc) => {
    const equipment = equipmentMap.get(toId(doc.equipmentId))
    const paymentStatus = String(doc.paymentStatus ?? "unpaid").toLowerCase()
    const bookingStatus = String(
      doc.bookingStatus ?? doc.status ?? "pending"
    ).toLowerCase()

    return {
      ...normalizeBooking(doc),
      equipmentImage: doc.equipmentImage ?? equipment?.image ?? "",
      equipmentCategory:
        doc.equipmentCategory ?? equipment?.category ?? "Uncategorized",
      canPay:
        paymentStatus !== "paid" &&
        !["cancelled", "completed"].includes(bookingStatus),
    }
  })
}

function validateProfile(body) {
  const patch = {}

  if (body.name !== undefined) {
    const value = String(body.name).trim()
    if (value.length < 2 || value.length > 80) {
      return { error: "Name must be between 2 and 80 characters." }
    }
    patch.name = value
  }

  if (body.phone !== undefined) {
    const value = String(body.phone).trim()
    if (value.length > 30) return { error: "Phone number is too long." }
    if (value && !/^[+\d()\s.-]{6,30}$/.test(value)) {
      return { error: "Enter a valid phone number." }
    }
    patch.phone = value
  }

  if (body.address !== undefined) {
    const value = String(body.address).trim()
    if (value.length > 200) return { error: "Address is too long." }
    patch.address = value
  }

  if (body.image !== undefined) {
    const value = String(body.image).trim()
    if (value && !/^https?:\/\//i.test(value)) {
      return { error: "Profile image must be an http(s) URL." }
    }
    patch.image = value || null
  }

  if (Object.keys(patch).length === 0) {
    return { error: "No supported fields were provided." }
  }

  return { patch }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

router.get("/overview", async (req, res, next) => {
  try {
    const [bookings, payments, favorites] = await Promise.all([
      customerBookings(req.user.id),
      collections.payments
        .find({ customerId: { $in: [req.user.id, ...(ObjectId.isValid(req.user.id) ? [new ObjectId(req.user.id)] : [])] } })
        .toArray(),
      collections.favorites.countDocuments({ customerId: req.user.id }),
    ])

    const recent = await serializeBookings(bookings.slice(0, 4))

    const paidPayments = payments
      .filter((payment) => payment.status === "paid")
      .reduce((sum, payment) => sum + toNumber(payment.amount), 0)
    const paidBookings = bookings
      .filter((booking) => booking.paymentStatus === "paid")
      .reduce((sum, booking) => sum + toNumber(booking.totalAmount), 0)

    return ok(res, {
      profile: req.user,
      stats: {
        totalRentals: bookings.length,
        activeRentals: bookings.filter(
          (booking) => booking.bookingStatus === "active"
        ).length,
        completedRentals: bookings.filter(
          (booking) => booking.bookingStatus === "completed"
        ).length,
        pendingPayments: bookings.filter(
          (booking) =>
            booking.paymentStatus !== "paid" &&
            !["cancelled", "completed"].includes(
              booking.bookingStatus ?? "pending"
            )
        ).length,
        totalSpent: paidPayments > 0 ? paidPayments : paidBookings,
        favorites,
      },
      recentBookings: recent,
    })
  } catch (error) {
    return next(error)
  }
})

// ---------------------------------------------------------------------------
// Rentals
// ---------------------------------------------------------------------------

router.get("/rentals", async (req, res, next) => {
  try {
    const bookingStatus = String(req.query.bookingStatus ?? "").toLowerCase()
    const paymentStatus = String(req.query.paymentStatus ?? "").toLowerCase()

    const docs = await customerBookings(req.user.id)
    const filtered = docs.filter((doc) => {
      const matchesBooking =
        !bookingStatus ||
        bookingStatus === "all" ||
        String(doc.bookingStatus ?? doc.status ?? "pending").toLowerCase() ===
          bookingStatus
      const matchesPayment =
        !paymentStatus ||
        paymentStatus === "all" ||
        String(doc.paymentStatus ?? "unpaid").toLowerCase() === paymentStatus
      return matchesBooking && matchesPayment
    })

    return ok(res, await serializeBookings(filtered))
  } catch (error) {
    return next(error)
  }
})

router.get("/rentals/:id", async (req, res, next) => {
  try {
    const booking = await collections.bookings.findOne({
      ...byIdFilter(req.params.id),
      ...customerOwnershipFilter(req.user.id),
    })

    if (!booking) return fail(res, 404, "Rental not found.")

    const [serialized] = await serializeBookings([booking])
    return ok(res, serialized)
  } catch (error) {
    return next(error)
  }
})

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

router.get("/payments", async (req, res, next) => {
  try {
    const payments = await collections.payments
      .find({
        customerId: {
          $in: [
            req.user.id,
            ...(ObjectId.isValid(req.user.id)
              ? [new ObjectId(req.user.id)]
              : []),
          ],
        },
      })
      .sort({ createdAt: -1 })
      .toArray()

    const bookings = await loadBookingsMap(
      payments.map((payment) => payment.bookingId)
    )

    return ok(
      res,
      payments.map((payment) =>
        normalizePayment(payment, Object.fromEntries(bookings))
      )
    )
  } catch (error) {
    return next(error)
  }
})

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

router.get("/profile", async (req, res) => {
  return ok(res, { ...req.user })
})

router.patch("/profile", async (req, res, next) => {
  try {
    const { patch, error } = validateProfile(req.body ?? {})
    if (error) return fail(res, 400, error)

    patch.updatedAt = new Date()

    const updated = await collections.users.findOneAndUpdate(
      byIdFilter(req.user.id),
      { $set: patch },
      { returnDocument: "after", projection: { password: 0 } }
    )

    if (!updated) return fail(res, 404, "Account not found.")

    return ok(res, {
      ...normalizeUser(updated),
      role: req.user.role,
    })
  } catch (error) {
    return next(error)
  }
})

export default router
