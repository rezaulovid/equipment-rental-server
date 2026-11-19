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

/** Public catalogue: only approved equipment is ever visible to customers. */
router.get("/", async (req, res, next) => {
  try {
    const filter = { status: "approved" }
    const search = String(req.query.q ?? "").trim()
    const category = String(req.query.category ?? "").trim()
    const location = String(req.query.location ?? "").trim()

    if (search) {
      const pattern = new RegExp(escapeRegExp(search), "i")
      filter.$or = [
        { name: pattern },
        { description: pattern },
        { category: pattern },
        { brand: pattern },
        { model: pattern },
        { location: pattern },
      ]
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

    const docs = await collections.equipment
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray()

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
