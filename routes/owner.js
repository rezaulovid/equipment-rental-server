import { Router } from "express"
import { ObjectId } from "mongodb"

import { collections } from "../lib/db.js"
import {
  BOOKING_STATUSES,
  BOOKING_TRANSITIONS,
  EQUIPMENT_STATUSES,
  normalizeBooking,
  normalizeEquipment,
  normalizePayment,
  normalizeRentalType,
  normalizeUser,
  toId,
  toNumber,
} from "../lib/normalize.js"
import {
  equipmentByIdFilter,
  idCandidates,
  inventoryHoldFilter,
  loadBookingsMap,
  loadEquipmentMap,
} from "../lib/records.js"
import { verifyOwner, verifyToken } from "../middleware/auth.js"

const router = Router()

// The API is the security boundary: every query below is scoped to the
// authenticated owner, never to an id supplied by the browser.
router.use(verifyToken, verifyOwner)

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data })

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message })

const parseId = (value) => (ObjectId.isValid(value) ? new ObjectId(value) : null)

/** Only the equipment that was created by the signed-in owner is visible. */
function ownerEquipmentFilter(ownerId) {
  return { ownerId: { $in: idCandidates(ownerId) } }
}

/** Only the rentals booked through the signed-in owner's equipment. */
function ownerBookingsFilter(ownerId) {
  return { ownerId: { $in: idCandidates(ownerId) } }
}

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

async function serializeOwnerBookings(docs) {
  const equipmentMap = await loadEquipmentMap(
    docs.map((doc) => doc.equipmentId)
  )
  const customers = await loadUsers(
    docs.map((doc) => doc.customerId ?? doc.customer?._id ?? doc.userId)
  )

  return docs.map((doc) => {
    const equipment = equipmentMap.get(toId(doc.equipmentId))
    const paymentStatus = String(doc.paymentStatus ?? "unpaid").toLowerCase()
    const bookingStatus = String(
      doc.bookingStatus ?? doc.status ?? "pending"
    ).toLowerCase()

    return {
      ...normalizeBooking(doc, customers, {}),
      equipmentImage: doc.equipmentImage ?? equipment?.image ?? "",
      equipmentCategory:
        doc.equipmentCategory ?? equipment?.category ?? "Uncategorized",
      canPay:
        paymentStatus !== "paid" &&
        !["cancelled", "completed"].includes(bookingStatus),
    }
  })
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** Aggregates the owner's listings, rentals and verified earnings. */
router.get("/analytics", async (req, res, next) => {
  try {
    const now = new Date()
    const seriesStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)
    )

    const [
      totalListings,
      statusGroups,
      completedRentals,
      earningsRows,
      monthlyBookingRows,
      monthlyRevenueRows,
    ] = await Promise.all([
      collections.equipment.countDocuments(ownerEquipmentFilter(req.user.id)),
      collections.equipment
        .aggregate([
          { $match: ownerEquipmentFilter(req.user.id) },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ])
        .toArray(),
      collections.bookings.countDocuments({
        ...ownerBookingsFilter(req.user.id),
        $or: [
          { bookingStatus: "completed" },
          {
            bookingStatus: { $exists: false },
            status: "completed",
          },
        ],
      }),
      collections.payments.aggregate([
        {
          $match: {
            ownerId: { $in: idCandidates(req.user.id) },
            status: "paid",
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]).toArray(),
      collections.bookings
        .aggregate([
          {
            $match: {
              ownerId: { $in: idCandidates(req.user.id) },
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
            },
          },
        ])
        .toArray(),
      collections.payments
        .aggregate([
          {
            $match: {
              ownerId: { $in: idCandidates(req.user.id) },
              status: "paid",
              paidAt: { $gte: seriesStart },
            },
          },
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

    const totalEarnings = toNumber(earningsRows[0]?.total)

    const countByStatus = (status) => byStatus[status] ?? 0

    return ok(res, {
      equipmentByStatus: byStatus,
      totalListings,
      pendingEquipment: countByStatus("pending"),
      approvedEquipment: countByStatus("approved"),
      rejectedEquipment: countByStatus("rejected"),
      completedRentals,
      totalEarnings,
      monthly,
    })
  } catch (error) {
    return next(error)
  }
})

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

/** Money-focused owner endpoint: verified earnings plus the monthly series. */
router.get("/earnings", async (req, res, next) => {
  try {
    const now = new Date()
    const seriesStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)
    )
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    )

    const payments = await collections.payments
      .find({
        ownerId: { $in: idCandidates(req.user.id) },
        status: "paid",
      })
      .sort({ paidAt: -1, createdAt: -1 })
      .toArray()

    const totalEarnings = payments.reduce(
      (sum, payment) => sum + toNumber(payment.amount),
      0
    )
    const earningsThisMonth = payments
      .filter((payment) => payment.paidAt && new Date(payment.paidAt) >= monthStart)
      .reduce((sum, payment) => sum + toNumber(payment.amount), 0)

    const monthlyRevenueRows = await collections.payments
      .aggregate([
        {
          $match: {
            ownerId: { $in: idCandidates(req.user.id) },
            status: "paid",
            paidAt: { $gte: seriesStart },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$paidAt" } },
            revenue: { $sum: "$amount" },
          },
        },
      ])
      .toArray()

    const revenueByMonth = new Map(
      monthlyRevenueRows.map((row) => [row._id, row.revenue])
    )

    const monthly = Array.from({ length: 12 }, (_, index) => {
      const date = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + index, 1)
      )
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`

      return {
        month: key,
        label: date.toLocaleDateString("en-US", {
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }),
        revenue: revenueByMonth.get(key) ?? 0,
      }
    })

    const bookings = await loadBookingsMap(payments.map((payment) => payment.bookingId))
    const rentals = payments.map((payment) =>
      normalizePayment(payment, Object.fromEntries(bookings))
    )

    return ok(res, {
      totalEarnings,
      earningsThisMonth,
      paidRentals: payments.length,
      monthly,
      rentals,
    })
  } catch (error) {
    return next(error)
  }
})

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

/** Lists the equipment that belongs to the signed-in owner. */
router.get("/equipment", async (req, res, next) => {
  try {
    const filter = { ...ownerEquipmentFilter(req.user.id) }
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
      filter.$or = [{ name: pattern }, { brand: pattern }, { model: pattern }]
    }

    const docs = await collections.equipment.find(filter).sort({ createdAt: -1 }).toArray()
    const users = await loadUsers(
      docs.map((doc) => toId(doc.ownerId ?? doc.owner?._id))
    )

    return ok(res, docs.map((doc) => normalizeEquipment(doc, users)))
  } catch (error) {
    return next(error)
  }
})

function validateOwnerEquipmentInput(body) {
  const name = String(body?.name ?? "").trim()
  if (name.length < 2 || name.length > 120) {
    return { error: "Equipment name must be between 2 and 120 characters." }
  }

  const description = String(body?.description ?? "").trim()
  if (description.length > 2000) {
    return { error: "Description must be at most 2000 characters." }
  }

  const category = String(body?.category ?? "").trim()
  if (category.length > 60) {
    return { error: "Category must be at most 60 characters." }
  }

  const location = String(body?.location ?? "").trim()
  if (location.length > 120) {
    return { error: "Location must be at most 120 characters." }
  }

  const condition = String(body?.condition ?? "").trim()
  if (condition.length > 60) {
    return { error: "Equipment condition must be at most 60 characters." }
  }

  const brand = String(body?.brand ?? "").trim()
  if (brand.length > 60) {
    return { error: "Brand must be at most 60 characters." }
  }

  const model = String(body?.model ?? "").trim()
  if (model.length > 60) {
    return { error: "Model must be at most 60 characters." }
  }

  const terms = String(body?.terms ?? "").trim()
  if (terms.length > 2000) {
    return { error: "Rental terms must be at most 2000 characters." }
  }

  const rentalPrice = Number(body?.rentalPrice)
  if (!Number.isFinite(rentalPrice) || rentalPrice <= 0) {
    return { error: "Rental price must be a positive number." }
  }

  const rentalType = normalizeRentalType(body?.rentalType)
  if (!["daily", "weekly", "monthly"].includes(rentalType)) {
    return { error: "Rental type must be daily, weekly or monthly." }
  }

  const availableQuantity = Number(body?.availableQuantity)
  if (!Number.isInteger(availableQuantity) || availableQuantity < 1) {
    return { error: "Available quantity must be a whole number of at least 1." }
  }

  const image = String(body?.image ?? "").trim()
  if (!/^https?:\/\//i.test(image)) {
    return { error: "Equipment image must be a valid image URL." }
  }

  return {
    value: {
      name,
      description,
      category,
      location,
      rentalPrice,
      rentalType,
      availableQuantity,
      condition,
      brand,
      model,
      image,
      terms,
    },
  }
}

/**
 * Owners submit equipment. New listings always start as pending because the
 * RentPro team (or an admin) must approve them before they are rented publicly.
 * Owners can never approve or reject their own listing.
 */
router.post("/equipment", async (req, res, next) => {
  try {
    const result = validateOwnerEquipmentInput(req.body)
    if (result.error) return fail(res, 400, result.error)

    const now = new Date()
    const equipmentDoc = {
      ...result.value,
      status: "pending",
      ownerId: req.user.id,
      ownerName: req.user.name,
      ownerEmail: req.user.email,
      createdAt: now,
      updatedAt: now,
    }

    const inserted = await collections.equipment.insertOne(equipmentDoc)

    const equipment = await collections.equipment.findOne({
      _id: inserted.insertedId,
    })
    const users = await loadUsers([toId(equipment?.ownerId ?? req.user.id)])

    return ok(
      res,
      normalizeEquipment(equipment ?? equipmentDoc, users),
      201
    )
  } catch (error) {
    return next(error)
  }
})

router.get("/equipment/:id", async (req, res, next) => {
  try {
    const equipment = await collections.equipment.findOne({
      ...equipmentByIdFilter(req.params.id),
      ...ownerEquipmentFilter(req.user.id),
    })

    if (!equipment) return fail(res, 404, "Equipment not found.")

    const users = await loadUsers([toId(equipment.ownerId ?? equipment.owner?._id)])
    return ok(res, normalizeEquipment(equipment, users))
  } catch (error) {
    return next(error)
  }
})

const OWNER_EQUIPMENT_PATCHABLE_FIELDS = [
  "name",
  "description",
  "category",
  "location",
  "rentalPrice",
  "rentalType",
  "availableQuantity",
  "condition",
  "brand",
  "model",
  "image",
  "terms",
]

router.patch("/equipment/:id", async (req, res, next) => {
  try {
    const equipment = await collections.equipment.findOne({
      ...equipmentByIdFilter(req.params.id),
      ...ownerEquipmentFilter(req.user.id),
    })

    if (!equipment) return fail(res, 404, "Equipment not found.")

    if (req.body?.status !== undefined) {
      return fail(res, 400, "Owners cannot change the equipment approval status.")
    }

    const patch = {}

    for (const field of OWNER_EQUIPMENT_PATCHABLE_FIELDS) {
      if (req.body?.[field] === undefined) continue

      const value = String(req.body[field]).trim()

      if (field === "name" && value.length < 2) {
        return fail(res, 400, "Equipment name is too short.")
      }

      const maxLength = {
        name: 120,
        description: 2000,
        category: 60,
        location: 120,
        condition: 60,
        brand: 60,
        model: 60,
        terms: 2000,
      }[field]

      if (value.length > maxLength) {
        return fail(res, 400, `${field} must be at most ${maxLength} characters.`)
      }

      patch[field] = value
    }

    if (req.body?.rentalPrice !== undefined) {
      const rentalPrice = Number(req.body.rentalPrice)
      if (!Number.isFinite(rentalPrice) || rentalPrice <= 0) {
        return fail(res, 400, "Rental price must be a positive number.")
      }
      patch.rentalPrice = rentalPrice
    }

    if (req.body?.availableQuantity !== undefined) {
      const availableQuantity = Number(req.body.availableQuantity)
      if (!Number.isInteger(availableQuantity) || availableQuantity < 1) {
        return fail(res, 400, "Available quantity must be a whole number of at least 1.")
      }
      patch.availableQuantity = availableQuantity
    }

    if (req.body?.rentalType !== undefined) {
      patch.rentalType = normalizeRentalType(req.body.rentalType)
    }

    if (Object.keys(patch).length === 0) {
      return fail(res, 400, "No supported fields were provided.")
    }

    patch.updatedAt = new Date()

    const updated = await collections.equipment.findOneAndUpdate(
      { _id: equipment._id },
      { $set: patch },
      { returnDocument: "after" }
    )

    if (!updated) return fail(res, 404, "Equipment not found.")

    const users = await loadUsers([toId(updated.ownerId ?? updated.owner?._id)])
    return ok(res, normalizeEquipment(updated, users))
  } catch (error) {
    return next(error)
  }
})

router.delete("/equipment/:id", async (req, res, next) => {
  try {
    const equipment = await collections.equipment.findOne({
      ...equipmentByIdFilter(req.params.id),
      ...ownerEquipmentFilter(req.user.id),
    })

    if (!equipment) return fail(res, 404, "Equipment not found.")

    const deleted = await collections.equipment.findOneAndDelete({
      _id: equipment._id,
    })

    // Booking history is kept on purpose: rentals snapshot the equipment they
    // rented, so deleting a listing must not erase past or pending requests.
    await collections.favorites.deleteMany({
      $or: [{ equipmentId: req.params.id }, { equipmentId: equipment._id }],
    })

    return ok(res, { id: toId(deleted?._id) })
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
    const search = String(req.query.q ?? "").trim()

    const docs = await collections.bookings
      .find(ownerBookingsFilter(req.user.id))
      .sort({ createdAt: -1 })
      .toArray()

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

      const matchesQuery =
        !search ||
        String(doc.equipmentName ?? "").toLowerCase().includes(
          search.toLowerCase()
        ) ||
        String(doc.customerName ?? "").toLowerCase().includes(
          search.toLowerCase()
        )

      return matchesBooking && matchesPayment && matchesQuery
    })

    const rentals = await serializeOwnerBookings(filtered)

    return ok(res, rentals)
  } catch (error) {
    return next(error)
  }
})

router.patch("/rentals/:id/status", async (req, res, next) => {
  try {
    const booking = await collections.bookings.findOne({
      ...byIdFilter(req.params.id),
      ...ownerBookingsFilter(req.user.id),
    })

    if (!booking) return fail(res, 404, "Rental not found.")

    const nextStatus = String(req.body?.bookingStatus ?? "").toLowerCase()
    if (!BOOKING_STATUSES.includes(nextStatus)) {
      return fail(
        res,
        400,
        `Booking status must be one of: ${BOOKING_STATUSES.join(", ")}.`
      )
    }

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

    const lifecycleFilter =
      booking.bookingStatus !== undefined && booking.bookingStatus !== null
        ? { bookingStatus: booking.bookingStatus }
        : booking.status !== undefined && booking.status !== null
          ? { status: booking.status }
          : { bookingStatus: { $exists: false }, status: { $exists: false } }
    const updateFilter = { _id: booking._id, ...lifecycleFilter }
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

    const [serialized] = await serializeOwnerBookings([updated])

    return ok(res, serialized)
  } catch (error) {
    return next(error)
  }
})

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function validateOwnerProfile(body) {
  const patch = {}

  if (body?.name !== undefined) {
    const value = String(body.name).trim()
    if (value.length < 2 || value.length > 80) {
      return { error: "Name must be between 2 and 80 characters." }
    }
    patch.name = value
  }

  if (body?.phone !== undefined) {
    const value = String(body.phone).trim()
    if (value.length > 30) return { error: "Phone number is too long." }
    if (value && !/^[+\d()\s.-]{6,30}$/.test(value)) {
      return { error: "Enter a valid phone number." }
    }
    patch.phone = value
  }

  if (body?.address !== undefined) {
    const value = String(body.address).trim()
    if (value.length > 200) return { error: "Address is too long." }
    patch.address = value
  }

  if (body?.image !== undefined) {
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

router.get("/profile", async (req, res) => {
  return ok(res, { ...req.user })
})

router.patch("/profile", async (req, res, next) => {
  try {
    const { patch, error } = validateOwnerProfile(req.body ?? {})
    if (error) return fail(res, 400, error)

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
