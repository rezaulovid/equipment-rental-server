import { Router } from "express"
import { ObjectId } from "mongodb"

import { collections } from "../lib/db.js"
import { toId } from "../lib/normalize.js"
import { parsePagination } from "../lib/pagination.js"
import {
  idCandidates,
  customerOwnershipFilter,
} from "../lib/records.js"
import { verifyRenter, verifyToken } from "../middleware/auth.js"

const router = Router()

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data })

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message })

function serializeReview(review) {
  return {
    id: toId(review._id),
    bookingId: toId(review.bookingId),
    customerName: review.customerName ?? "Customer",
    rating: review.rating,
    message: review.message,
    createdAt: review.createdAt?.toISOString?.() ?? null,
  }
}

router.get("/", async (req, res, next) => {
  try {
    const pagination = parsePagination(req.query, {
      defaultLimit: 8,
      maxLimit: 50,
    })
    if (pagination.error) return fail(res, 400, pagination.error)

    const filter = { status: "approved" }
    if (req.query.equipmentId !== undefined) {
      const equipmentId = String(req.query.equipmentId).trim()
      if (!ObjectId.isValid(equipmentId)) {
        return fail(res, 400, "Invalid equipment id.")
      }
      filter.equipmentId = { $in: idCandidates(equipmentId) }
    }

    const reviews = await collections.reviews
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit ?? 8)
      .toArray()

    return ok(res, reviews.map(serializeReview))
  } catch (error) {
    return next(error)
  }
})

router.get("/mine/:bookingId", verifyToken, verifyRenter, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.bookingId)) {
      return fail(res, 400, "Invalid booking reference.")
    }

    const review = await collections.reviews.findOne({
      bookingId: { $in: [req.params.bookingId, new ObjectId(req.params.bookingId)] },
      customerId: { $in: idCandidates(req.user.id) },
    })

    return ok(res, review ? serializeReview(review) : null)
  } catch (error) {
    return next(error)
  }
})

router.post("/", verifyToken, verifyRenter, async (req, res, next) => {
  try {
    const bookingId = String(req.body?.bookingId ?? "").trim()
    const rating = Number(req.body?.rating)
    const message = String(req.body?.message ?? "").trim()

    if (!ObjectId.isValid(bookingId)) {
      return fail(res, 400, "Choose a valid completed rental.")
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return fail(res, 400, "Rating must be a whole number from 1 to 5.")
    }
    if (message.length < 20 || message.length > 500) {
      return fail(res, 400, "Review must be between 20 and 500 characters.")
    }

    const booking = await collections.bookings.findOne({
      _id: { $in: idCandidates(bookingId) },
      ...customerOwnershipFilter(req.user.id),
      paymentStatus: "paid",
      bookingStatus: "completed",
    })

    if (!booking) {
      return fail(res, 404, "Only paid, completed rentals can be reviewed.")
    }

    const review = {
      bookingId: toId(booking._id),
      customerId: req.user.id,
      customerName: req.user.name || "Customer",
      equipmentId: toId(booking.equipmentId),
      equipmentName: booking.equipmentName ?? "Equipment",
      rating,
      message,
      status: "approved",
      createdAt: new Date(),
    }

    try {
      const result = await collections.reviews.insertOne(review)
      return ok(res, serializeReview({ ...review, _id: result.insertedId }), 201)
    } catch (error) {
      if (error?.code === 11000) {
        return fail(res, 409, "A review has already been submitted for this rental.")
      }

      throw error
    }
  } catch (error) {
    return next(error)
  }
})

export default router
