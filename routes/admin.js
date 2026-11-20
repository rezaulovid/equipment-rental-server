import { Router } from "express"
import { ObjectId } from "mongodb"

import { collections } from "../lib/db.js"
import {
  bookingLifecycleFilter,
  acquireEquipmentReservationLock,
  inventoryHoldFilter,
  maximumReservedQuantity,
  releaseEquipmentReservationLock,
} from "../lib/records.js"
import {
  BOOKING_STATUSES,
  BOOKING_TRANSITIONS,
  EQUIPMENT_STATUSES,
  USER_ROLES,
  isSupportedRentalType,
  normalizeBooking,
  normalizeEquipment,
  normalizeRentalType,
  normalizeUser,
  toId,
  toNumber,
} from "../lib/normalize.js"
import { verifyAdmin, verifyToken } from "../middleware/auth.js"

const router = Router()

// Every admin route requires a valid BetterAuth JWT and an admin role that is
// read from the database inside verifyToken.
router.use(verifyToken, verifyAdmin)

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message })

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data })

const parseId = (value) => (ObjectId.isValid(value) ? new ObjectId(value) : null)

/** Loads the display names/emails referenced by a batch of documents. */
async function loadUsers(ids) {
  const unique = [...new Set(ids.filter((id) => ObjectId.isValid(id)))]
  if (unique.length === 0) return {}

  const docs = await collections.users
    .find(
      { _id: { $in: unique.map((id) => new ObjectId(id)) } },
      { projection: { name: 1, email: 1, image: 1, role: 1, phone: 1, address: 1 } }
    )
    .toArray()

  return Object.fromEntries(
    docs.map((doc) => [
      doc._id.toString(),
      {
        name: doc.name ?? "",
        email: doc.email ?? "",
        image: doc.image ?? null,
        role: doc.role ?? "customer",
        phone: doc.phone ?? "",
        address: doc.address ?? "",
      },
    ])
  )
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** Aggregates the overview cards plus the monthly booking/revenue series. */
router.get("/analytics", async (_req, res, next) => {
  try {
    const now = new Date()
    const seriesStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)
    )

    const [
      totalUsers,
      totalEquipment,
      totalBookings,
      completedRentals,
      pendingApprovals,
      statusGroups,
      paidPayments,
      paidBookings,
      monthlyBookingRows,
      monthlyRevenueRows,
    ] = await Promise.all([
      collections.users.countDocuments({}),
      collections.equipment.countDocuments({}),
      collections.bookings.countDocuments({}),
      collections.bookings.countDocuments({ bookingStatus: "completed" }),
      collections.equipment.countDocuments({
        $or: [{ status: "pending" }, { status: { $exists: false } }],
      }),
      collections.equipment
        .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
        .toArray(),
      collections.payments
        .aggregate([
          { $match: { status: "paid" } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ])
        .toArray(),
      collections.bookings
        .aggregate([
          { $match: { paymentStatus: "paid" } },
          { $group: { _id: null, total: { $sum: "$totalAmount" } } },
        ])
        .toArray(),
      collections.bookings
        .aggregate([
          {
            $match: {
              $or: [
                { createdAt: { $gte: seriesStart } },
                { startDate: { $gte: seriesStart } },
              ],
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m",
                  date: { $ifNull: ["$createdAt", "$startDate"] },
                },
              },
              bookings: { $sum: 1 },
              amount: { $sum: "$totalAmount" },
            },
          },
        ])
        .toArray(),
      collections.payments
        .aggregate([
          { $match: { status: "paid", paidAt: { $gte: seriesStart } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$paidAt" } },
              revenue: { $sum: "$amount" },
            },
          },
        ])
        .toArray(),
    ])

    const byStatus = { pending: 0, approved: 0, rejected: 0 }
    for (const group of statusGroups) {
      const key = String(group._id ?? "pending").toLowerCase()
      if (key in byStatus) byStatus[key] = group.count
    }

    const bookingByMonth = new Map(
      monthlyBookingRows.map((row) => [row._id, row])
    )
    const revenueByMonth = new Map(
      monthlyRevenueRows.map((row) => [row._id, row.revenue])
    )

    const monthly = Array.from({ length: 12 }, (_, index) => {
      const date = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + index, 1)
      )
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
      const bookingRow = bookingByMonth.get(key)

      return {
        month: key,
        label: date.toLocaleDateString("en-US", {
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }),
        bookings: bookingRow?.bookings ?? 0,
        revenue: revenueByMonth.get(key) ?? 0,
      }
    })

    // Payments are the source of truth for money; fall back to bookings when
    // the payments collection has not been populated yet.
    const revenueFromPayments = toNumber(paidPayments[0]?.total)
    const revenueFromBookings = toNumber(paidBookings[0]?.total)

    return ok(res, {
      totalUsers,
      totalEquipment,
      totalBookings,
      pendingApprovals,
      completedRentals,
      totalRevenue:
        revenueFromPayments > 0 ? revenueFromPayments : revenueFromBookings,
      equipmentByStatus: byStatus,
      monthly,
    })
  } catch (error) {
    return next(error)
  }
})

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

router.get("/users", async (_req, res, next) => {
  try {
    const docs = await collections.users
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray()

    return ok(res, docs.map(normalizeUser))
  } catch (error) {
    return next(error)
  }
})

router.patch("/users/:id/role", async (req, res, next) => {
  try {
    const _id = parseId(req.params.id)
    if (!_id) return fail(res, 400, "Invalid user id.")

    const role = String(req.body?.role ?? "").toLowerCase()
    if (!USER_ROLES.includes(role)) {
      return fail(res, 400, `Role must be one of: ${USER_ROLES.join(", ")}.`)
    }

    // An admin can promote others but never rewrite their own role. That keeps
    // at least one admin in the system and blocks self-escalation paths.
    if (req.user.id === req.params.id) {
      return fail(res, 400, "You cannot change your own role.")
    }

    const updated = await collections.users.findOneAndUpdate(
      { _id },
      { $set: { role, updatedAt: new Date() } },
      { returnDocument: "after", projection: { password: 0 } }
    )

    if (!updated) return fail(res, 404, "User not found.")
    return ok(res, normalizeUser(updated))
  } catch (error) {
    return next(error)
  }
})

router.patch("/users/:id/ban", async (req, res, next) => {
  try {
    const _id = parseId(req.params.id)
    if (!_id) return fail(res, 400, "Invalid user id.")

    if (typeof req.body?.banned !== "boolean") {
      return fail(res, 400, "banned must be a boolean.")
    }
    if (_id.toString() === req.user.id && req.body.banned) {
      return fail(res, 400, "You cannot suspend your own account.")
    }

    const banReason = String(req.body?.banReason ?? "").trim()
    if (req.body.banned && (banReason.length < 3 || banReason.length > 500)) {
      return fail(res, 400, "Ban reason must be between 3 and 500 characters.")
    }

    const updated = await collections.users.findOneAndUpdate(
      { _id },
      {
        $set: {
          banned: req.body.banned,
          banReason: req.body.banned ? banReason : null,
          banExpires: null,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after", projection: { password: 0 } }
    )

    if (!updated) return fail(res, 404, "User not found.")
    return ok(res, normalizeUser(updated))
  } catch (error) {
    return next(error)
  }
})

router.patch("/users/:id", async (req, res, next) => {
  try {
    const _id = parseId(req.params.id)
    if (!_id) return fail(res, 400, "Invalid user id.")

    const patch = {}
    const { name, phone, address, image } = req.body ?? {}

    if (name !== undefined) {
      const value = String(name).trim()
      if (value.length < 2 || value.length > 80) {
        return fail(res, 400, "Name must be between 2 and 80 characters.")
      }
      patch.name = value
    }

    if (phone !== undefined) {
      const value = String(phone).trim()
      if (value.length > 30) return fail(res, 400, "Phone number is too long.")
      patch.phone = value
    }

    if (address !== undefined) {
      const value = String(address).trim()
      if (value.length > 200) return fail(res, 400, "Address is too long.")
      patch.address = value
    }

    if (image !== undefined) {
      const value = String(image).trim()
      if (value && !/^https?:\/\//i.test(value)) {
        return fail(res, 400, "Profile image must be an http(s) URL.")
      }
      patch.image = value || null
    }

    if (Object.keys(patch).length === 0) {
      return fail(res, 400, "No supported fields were provided.")
    }

    patch.updatedAt = new Date()

    const updated = await collections.users.findOneAndUpdate(
      { _id },
      { $set: patch },
      { returnDocument: "after", projection: { password: 0 } }
    )

    if (!updated) return fail(res, 404, "User not found.")
    return ok(res, normalizeUser(updated))
  } catch (error) {
    return next(error)
  }
})

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

router.get("/equipment", async (req, res, next) => {
  try {
    const filter = {}
    const status = String(req.query.status ?? "").toLowerCase()

    if (status && status !== "all") {
      if (!EQUIPMENT_STATUSES.includes(status)) {
        return fail(res, 400, "Unknown equipment status filter.")
      }
      filter.status = status
    }

    const search = String(req.query.q ?? "").trim()
    if (search) {
      const pattern = new RegExp(
        search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      )
      filter.$or = [
        { name: pattern },
        { ownerName: pattern },
        { ownerEmail: pattern },
      ]
    }

    const docs = await collections.equipment
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray()

    const owners = await loadUsers(
      docs.map((doc) => toId(doc.ownerId ?? doc.owner?._id))
    )

    return ok(res, docs.map((doc) => normalizeEquipment(doc, owners)))
  } catch (error) {
    return next(error)
  }
})

router.patch("/equipment/:id/status", async (req, res, next) => {
  try {
    const _id = parseId(req.params.id)
    if (!_id) return fail(res, 400, "Invalid equipment id.")

    const status = String(req.body?.status ?? "").toLowerCase()
    if (!EQUIPMENT_STATUSES.includes(status)) {
      return fail(
        res,
        400,
        `Status must be one of: ${EQUIPMENT_STATUSES.join(", ")}.`
      )
    }

    const updated = await collections.equipment.findOneAndUpdate(
      { _id },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: "after" }
    )

    if (!updated) return fail(res, 404, "Equipment not found.")

    const owners = await loadUsers([toId(updated.ownerId ?? updated.owner?._id)])
    return ok(res, normalizeEquipment(updated, owners))
  } catch (error) {
    return next(error)
  }
})

const EQUIPMENT_TEXT_FIELDS = {
  name: 120,
  description: 2000,
  category: 60,
  location: 120,
  condition: 60,
  brand: 60,
  model: 60,
  terms: 2000,
}

router.patch("/equipment/:id", async (req, res, next) => {
  try {
    const _id = parseId(req.params.id)
    if (!_id) return fail(res, 400, "Invalid equipment id.")

    const body = req.body ?? {}
    const patch = {}

    for (const [field, max] of Object.entries(EQUIPMENT_TEXT_FIELDS)) {
      if (body[field] === undefined) continue
      const value = String(body[field]).trim()
      if (field === "name" && value.length < 2) {
        return fail(res, 400, "Equipment name is too short.")
      }
      if (value.length > max) {
        return fail(res, 400, `${field} must be at most ${max} characters.`)
      }
      patch[field] = value
    }

    if (body.rentalPrice !== undefined) {
      const value = Number(body.rentalPrice)
      if (!Number.isFinite(value) || value < 0) {
        return fail(res, 400, "Rental price must be a positive number.")
      }
      patch.rentalPrice = value
    }

    if (body.availableQuantity !== undefined) {
      const value = Number(body.availableQuantity)
      if (!Number.isInteger(value) || value < 0) {
        return fail(res, 400, "Available quantity must be a whole number.")
      }
      patch.availableQuantity = value
    }

    if (body.rentalType !== undefined) {
      if (!isSupportedRentalType(body.rentalType)) {
        return fail(res, 400, "Rental type must be daily, weekly or monthly.")
      }
      patch.rentalType = normalizeRentalType(body.rentalType)
    }

    if (body.status !== undefined) {
      const status = String(body.status).toLowerCase()
      if (!EQUIPMENT_STATUSES.includes(status)) {
        return fail(res, 400, "Unknown equipment status.")
      }
      patch.status = status
    }

    if (body.image !== undefined) {
      const value = String(body.image).trim()
      if (value && !/^https?:\/\//i.test(value) && !value.startsWith("/")) {
        return fail(res, 400, "Image must be an http(s) URL or a local path.")
      }
      patch.image = value
    }

    if (Object.keys(patch).length === 0) {
      return fail(res, 400, "No supported fields were provided.")
    }

    patch.updatedAt = new Date()

    const existing = await collections.equipment.findOne({ _id })
    if (!existing) return fail(res, 404, "Equipment not found.")

    const currentQuantity = toNumber(
      existing.availableQuantity ?? existing.quantity
    )
    const reducingInventory =
      patch.availableQuantity !== undefined &&
      patch.availableQuantity < currentQuantity
    const lockToken = reducingInventory
      ? await acquireEquipmentReservationLock(_id)
      : null

    if (reducingInventory && !lockToken) {
      return fail(
        res,
        409,
        "Equipment is being booked. Please try the inventory update again."
      )
    }

    try {
      if (
        reducingInventory &&
        patch.availableQuantity < (await maximumReservedQuantity(_id))
      ) {
        return fail(
          res,
          409,
          "Available quantity cannot be lower than units already reserved."
        )
      }

      const updated = await collections.equipment.findOneAndUpdate(
        { _id },
        { $set: patch },
        { returnDocument: "after" }
      )

      if (!updated) return fail(res, 404, "Equipment not found.")

      const owners = await loadUsers([toId(updated.ownerId ?? updated.owner?._id)])
      return ok(res, normalizeEquipment(updated, owners))
    } finally {
      if (lockToken) {
        await releaseEquipmentReservationLock(_id, lockToken)
      }
    }
  } catch (error) {
    return next(error)
  }
})

router.delete("/equipment/:id", async (req, res, next) => {
  try {
    const _id = parseId(req.params.id)
    if (!_id) return fail(res, 400, "Invalid equipment id.")

    const equipment = await collections.equipment.findOne({ _id })
    if (!equipment) return fail(res, 404, "Equipment not found.")

    const lockToken = await acquireEquipmentReservationLock(_id)
    if (!lockToken) {
      return fail(
        res,
        409,
        "Equipment is being booked. Please try deleting it again."
      )
    }

    try {
      const outstandingBooking = await collections.bookings.findOne(
        {
          ...inventoryHoldFilter(_id),
          endDate: { $gt: new Date() },
        },
        { projection: { _id: 1 } }
      )
      if (outstandingBooking) {
        return fail(
          res,
          409,
          "Equipment cannot be deleted while it has active or upcoming rentals."
        )
      }

      const deleted = await collections.equipment.findOneAndDelete({ _id })
      if (!deleted) return fail(res, 404, "Equipment not found.")

      // Keep favorites consistent with the public catalogue. Favorites may
      // store the id as either a string or an ObjectId depending on the writer.
      await collections.favorites.deleteMany({
        $or: [{ equipmentId: req.params.id }, { equipmentId: _id }],
      })

      return ok(res, { id: req.params.id })
    } finally {
      await releaseEquipmentReservationLock(_id, lockToken)
    }
  } catch (error) {
    return next(error)
  }
})

// ---------------------------------------------------------------------------
// Rentals
// ---------------------------------------------------------------------------

router.get("/rentals", async (req, res, next) => {
  try {
    const filter = {}
    const bookingStatus = String(req.query.bookingStatus ?? "").toLowerCase()
    const paymentStatus = String(req.query.paymentStatus ?? "").toLowerCase()

    if (bookingStatus && bookingStatus !== "all") {
      if (!BOOKING_STATUSES.includes(bookingStatus)) {
        return fail(res, 400, "Unknown booking status filter.")
      }
      filter.bookingStatus = bookingStatus
    }

    if (paymentStatus && paymentStatus !== "all") {
      filter.paymentStatus = paymentStatus
    }

    const docs = await collections.bookings
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray()

    const users = await loadUsers([
      ...docs.map((doc) => toId(doc.customerId ?? doc.customer?._id ?? doc.userId)),
      ...docs.map((doc) => toId(doc.ownerId ?? doc.owner?._id)),
    ])

    return ok(
      res,
      docs.map((doc) => normalizeBooking(doc, users, users))
    )
  } catch (error) {
    return next(error)
  }
})

router.patch("/rentals/:id/status", async (req, res, next) => {
  try {
    const _id = parseId(req.params.id)
    if (!_id) return fail(res, 400, "Invalid rental id.")

    const nextStatus = String(req.body?.bookingStatus ?? "").toLowerCase()
    if (!BOOKING_STATUSES.includes(nextStatus)) {
      return fail(
        res,
        400,
        `Booking status must be one of: ${BOOKING_STATUSES.join(", ")}.`
      )
    }

    const booking = await collections.bookings.findOne({ _id })
    if (!booking) return fail(res, 404, "Rental not found.")

    const current = String(
      booking.bookingStatus ?? booking.status ?? "pending"
    ).toLowerCase()
    const allowed = BOOKING_TRANSITIONS[current] ?? []

    if (current !== nextStatus && !allowed.includes(nextStatus)) {
      return fail(
        res,
        400,
        `A ${current} rental cannot move to ${nextStatus}.`
      )
    }

    if (
      ["active", "completed"].includes(nextStatus) &&
      String(booking.paymentStatus ?? "unpaid").toLowerCase() !== "paid"
    ) {
      return fail(res, 400, "Only paid rentals can be activated or completed.")
    }

    const updateFilter = { _id, ...bookingLifecycleFilter(booking) }
    if (["active", "completed"].includes(nextStatus)) {
      updateFilter.paymentStatus = "paid"
    }

    const updated = await collections.bookings.findOneAndUpdate(
      updateFilter,
      { $set: { bookingStatus: nextStatus, updatedAt: new Date() } },
      { returnDocument: "after" }
    )

    if (!updated) {
      return fail(res, 409, "Rental status changed. Refresh and try again.")
    }

    const users = await loadUsers([
      toId(updated.customerId ?? updated.customer?._id ?? updated.userId),
      toId(updated.ownerId ?? updated.owner?._id),
    ])

    return ok(res, normalizeBooking(updated, users, users))
  } catch (error) {
    return next(error)
  }
})

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

router.get("/profile", async (req, res) => {
  return ok(res, req.user)
})

router.patch("/profile", async (req, res, next) => {
  try {
    const body = req.body ?? {}
    const patch = {}

    if (body.name !== undefined) {
      const value = String(body.name).trim()
      if (value.length < 2 || value.length > 80) {
        return fail(res, 400, "Name must be between 2 and 80 characters.")
      }
      patch.name = value
    }

    if (body.phone !== undefined) {
      const value = String(body.phone).trim()
      if (value.length > 30) return fail(res, 400, "Phone number is too long.")
      patch.phone = value
    }

    if (body.address !== undefined) {
      const value = String(body.address).trim()
      if (value.length > 200) return fail(res, 400, "Address is too long.")
      patch.address = value
    }

    if (body.image !== undefined) {
      const value = String(body.image).trim()
      if (value && !/^https?:\/\//i.test(value)) {
        return fail(res, 400, "Profile image must be an http(s) URL.")
      }
      patch.image = value || null
    }

    if (Object.keys(patch).length === 0) {
      return fail(res, 400, "No supported fields were provided.")
    }

    patch.updatedAt = new Date()

    const updated = await collections.users.findOneAndUpdate(
      { _id: new ObjectId(req.user.id) },
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
