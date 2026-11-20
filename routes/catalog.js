import { Router } from "express"

import { collections } from "../lib/db.js"
import { normalizeEquipment, toId, toNumber } from "../lib/normalize.js"
import {
  byIdFilter,
  equipmentByIdFilter,
  idCandidates,
  inventoryHoldFilter,
} from "../lib/records.js"
import { validateRentalDates } from "../lib/pricing.js"

const router = Router()

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data })

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message })

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function parsePrice(value, field) {
  if (value === undefined || value === "") return undefined

  const price = Number(value)
  if (!Number.isFinite(price) || price < 0) {
    const error = new Error(`${field} must be a non-negative number.`)
    error.status = 400
    throw error
  }

  return price
}

function parseLimit(value) {
  if (value === undefined || value === "") return undefined

  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    const error = new Error("Limit must be a whole number between 1 and 100.")
    error.status = 400
    throw error
  }

  return limit
}

const rentalTypeAliases = {
  daily: ["daily", "day"],
  weekly: ["weekly", "week"],
  monthly: ["monthly", "month"],
}

/** Public catalogue: only approved equipment is ever visible to customers. */
router.get("/", async (req, res, next) => {
  try {
    const filter = { status: "approved" }
    const additionalClauses = []
    const search = String(req.query.q ?? "").trim()
    const category = String(req.query.category ?? "").trim()
    const location = String(req.query.location ?? "").trim()
    const rentalType = String(req.query.rentalType ?? "").trim().toLowerCase()
    const availability = String(req.query.availability ?? "").trim().toLowerCase()
    const sort = String(req.query.sort ?? "recent").trim().toLowerCase()
    const minPrice = parsePrice(req.query.minPrice, "Minimum price")
    const maxPrice = parsePrice(req.query.maxPrice, "Maximum price")
    const limit = parseLimit(req.query.limit)

    if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
      return fail(res, 400, "Minimum price cannot be greater than maximum price.")
    }

    if (rentalType && !rentalTypeAliases[rentalType]) {
      return fail(res, 400, "Rental type must be daily, weekly, or monthly.")
    }

    if (availability && !["available", "unavailable"].includes(availability)) {
      return fail(res, 400, "Availability must be available or unavailable.")
    }

    if (!["recent", "price-asc", "price-desc"].includes(sort)) {
      return fail(res, 400, "Sort must be recent, price-asc, or price-desc.")
    }

    if (search) {
      const pattern = new RegExp(escapeRegExp(search), "i")
      additionalClauses.push({
        $or: [
          { name: pattern },
          { description: pattern },
          { category: pattern },
          { brand: pattern },
          { model: pattern },
          { location: pattern },
        ],
      })
    }

    if (category && category !== "all") {
      // Homepage category links use slugs such as "construction". Match the
      // beginning of the stored category ("Construction Equipment").
      const normalized = category.replace(/-/g, " ")
      filter.category = new RegExp(`^${escapeRegExp(normalized)}`, "i")
    }

    if (location && location !== "all") {
      filter.location = new RegExp(escapeRegExp(location), "i")
    }

    if (rentalType) {
      additionalClauses.push({
        $or: [
          { rentalType: { $in: rentalTypeAliases[rentalType] } },
          {
            rentalType: { $in: [null, ""] },
            rentalPeriod: { $in: rentalTypeAliases[rentalType] },
          },
        ],
      })
    }

    if (additionalClauses.length > 0) {
      filter.$and = additionalClauses
    }

    const priceExpression = {
      $convert: {
        input: { $ifNull: ["$rentalPrice", "$price"] },
        to: "double",
        onError: 0,
        onNull: 0,
      },
    }
    const priceConditions = []
    if (minPrice !== undefined) {
      priceConditions.push({ $gte: [priceExpression, minPrice] })
    }
    if (maxPrice !== undefined) {
      priceConditions.push({ $lte: [priceExpression, maxPrice] })
    }
    if (priceConditions.length > 0) {
      filter.$expr = { $and: priceConditions }
    }

    const sortField =
      sort === "recent"
        ? { createdAt: -1, _id: -1 }
        : { _catalogPrice: sort === "price-asc" ? 1 : -1, _id: 1 }
    let docs = await collections.equipment
      .aggregate([
        { $match: filter },
        { $addFields: { _catalogPrice: priceExpression } },
        { $sort: sortField },
      ])
      .toArray()

    if (availability) {
      const dayStart = new Date()
      dayStart.setUTCHours(0, 0, 0, 0)
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
      const equipmentIds = docs.flatMap((doc) => idCandidates(doc._id))
      const overlapping = equipmentIds.length
        ? await collections.bookings
            .find({
              equipmentId: { $in: equipmentIds },
              bookingStatus: { $in: ["pending", "active"] },
              startDate: { $lt: dayEnd },
              endDate: { $gt: dayStart },
              $or: [
                { paymentStatus: "paid" },
                {
                  paymentStatus: { $in: ["pending", "unpaid"] },
                  createdAt: { $gte: new Date(Date.now() - 35 * 60 * 1000) },
                },
              ],
            })
            .toArray()
        : []

      const reservedByEquipment = new Map()
      for (const booking of overlapping) {
        const id = toId(booking.equipmentId)
        reservedByEquipment.set(
          id,
          (reservedByEquipment.get(id) ?? 0) + toNumber(booking.quantity, 1)
        )
      }

      docs = docs.filter((doc) => {
        const quantity = toNumber(doc.availableQuantity ?? doc.quantity, 0)
        const reserved = reservedByEquipment.get(toId(doc._id)) ?? 0
        const isAvailable = quantity - reserved > 0
        return availability === "available" ? isAvailable : !isAvailable
      })
    }

    if (limit !== undefined) {
      docs = docs.slice(0, limit)
    }

    const owners = await collections.users
      .find({
        _id: {
          $in: docs
            .map((doc) => doc.ownerId)
            .filter(Boolean)
            .flatMap(idCandidates),
        },
      })
      .toArray()
      .catch(() => [])

    const ownerMap = Object.fromEntries(
      owners.map((owner) => [
        toId(owner._id),
        { name: owner.name ?? "", email: owner.email ?? "" },
      ])
    )

    return ok(res, docs.map((doc) => normalizeEquipment(doc, ownerMap)))
  } catch (error) {
    return next(error)
  }
})

router.get("/categories", async (_req, res, next) => {
  try {
    const categories = await collections.equipment.distinct("category", {
      status: "approved",
    })

    return ok(
      res,
      categories
        .filter((category) => typeof category === "string" && category.trim())
        .map((category) => category.trim())
        .sort((a, b) => a.localeCompare(b))
    )
  } catch (error) {
    return next(error)
  }
})

router.get("/:id/availability", async (req, res, next) => {
  try {
    const equipment = await collections.equipment.findOne(
      equipmentByIdFilter(req.params.id)
    )

    if (!equipment || String(equipment.status).toLowerCase() !== "approved") {
      return fail(res, 404, "Equipment not found.")
    }

    const dates = validateRentalDates(
      req.query.startDate,
      req.query.endDate
    )

    if (!dates.valid) return fail(res, 400, dates.message)

    const overlap = await collections.bookings
      .find({
        ...inventoryHoldFilter(req.params.id),
        startDate: { $lt: dates.endDate },
        endDate: { $gt: dates.startDate },
      })
      .toArray()

    const bookedQuantity = overlap.reduce(
      (sum, booking) => sum + toNumber(booking.quantity, 1),
      0
    )
    const totalQuantity = toNumber(
      equipment.availableQuantity ?? equipment.quantity,
      0
    )

    return ok(res, {
      equipmentId: toId(equipment._id),
      totalQuantity,
      bookedQuantity,
      availableQuantity: Math.max(totalQuantity - bookedQuantity, 0),
      startDate: dates.startDate.toISOString(),
      endDate: dates.endDate.toISOString(),
    })
  } catch (error) {
    return next(error)
  }
})

router.get("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id)
    let equipment = await collections.equipment.findOne(
      equipmentByIdFilter(id)
    )

    // Support human-friendly slug links used by the marketing pages.
    if (!equipment && !/^[a-f\d]{24}$/i.test(id)) {
      const slug = id.replace(/-/g, " ")
      equipment = await collections.equipment.findOne({
        status: "approved",
        $or: [
          { slug: id },
          { name: new RegExp(`^${escapeRegExp(slug)}$`, "i") },
        ],
      })
    }

    if (!equipment || String(equipment.status).toLowerCase() !== "approved") {
      return fail(res, 404, "Equipment not found.")
    }

    const owner = equipment.ownerId
      ? await collections.users.findOne(byIdFilter(equipment.ownerId))
      : null

    const ownerMap = owner
      ? {
          [toId(owner._id)]: {
            name: owner.name ?? "",
            email: owner.email ?? "",
          },
        }
      : {}

    return ok(res, normalizeEquipment(equipment, ownerMap))
  } catch (error) {
    return next(error)
  }
})

export default router
