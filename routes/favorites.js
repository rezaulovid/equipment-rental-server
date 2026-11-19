import { Router } from "express"
import { ObjectId } from "mongodb"

import { collections } from "../lib/db.js"
import {
  normalizeEquipment,
  toId,
} from "../lib/normalize.js"
import { equipmentByIdFilter, idCandidates } from "../lib/records.js"
import { verifyRenter, verifyToken } from "../middleware/auth.js"

const router = Router()

// Favorites are always scoped to the authenticated customer's id.
router.use(verifyToken, verifyRenter)

const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data })

const fail = (res, status, message) =>
  res.status(status).json({ success: false, message })

function customerFilter(customerId) {
  return { customerId: { $in: idCandidates(customerId) } }
}

/** Lightweight list used by equipment cards to render their heart state. */
router.get("/ids", async (req, res, next) => {
  try {
    const docs = await collections.favorites
      .find(customerFilter(req.user.id), { projection: { equipmentId: 1 } })
      .toArray()

    return ok(
      res,
      docs.map((doc) => toId(doc.equipmentId)).filter(Boolean)
    )
  } catch (error) {
    return next(error)
  }
})

router.get("/", async (req, res, next) => {
  try {
    const favorites = await collections.favorites
      .find(customerFilter(req.user.id))
      .sort({ createdAt: -1 })
      .toArray()

    if (favorites.length === 0) return ok(res, [])

    const equipmentIds = favorites.map((favorite) => favorite.equipmentId)
    const equipmentDocs = await collections.equipment
      .find({
        _id: {
          $in: equipmentIds.flatMap(idCandidates),
        },
        status: "approved",
      })
      .toArray()

    const equipmentMap = new Map(
      equipmentDocs.map((doc) => [toId(doc._id), doc])
    )

    const items = favorites
      .map((favorite) => {
        const equipment = equipmentMap.get(toId(favorite.equipmentId))
        if (!equipment) return null

        return {
          ...normalizeEquipment(equipment),
          favoritedAt: favorite.createdAt
            ? new Date(favorite.createdAt).toISOString()
            : null,
        }
      })
      .filter(Boolean)

    return ok(res, items)
  } catch (error) {
    return next(error)
  }
})

router.post("/", async (req, res, next) => {
  try {
    const rawId = String(req.body?.equipmentId ?? "").trim()

    if (!ObjectId.isValid(rawId)) {
      return fail(res, 400, "Choose a valid equipment item.")
    }

    const equipment = await collections.equipment.findOne(
      equipmentByIdFilter(rawId)
    )

    if (!equipment || String(equipment.status).toLowerCase() !== "approved") {
      return fail(res, 404, "This equipment is not available to save.")
    }

    const equipmentId = toId(equipment._id)
    const now = new Date()

    try {
      await collections.favorites.updateOne(
        { customerId: req.user.id, equipmentId },
        {
          $setOnInsert: {
            customerId: req.user.id,
            equipmentId,
            createdAt: now,
          },
        },
        { upsert: true }
      )
    } catch (error) {
      // A concurrent request already inserted the same pair.
      if (error?.code !== 11000) throw error
    }

    return ok(
      res,
      {
        equipmentId,
        favoritedAt: now.toISOString(),
      },
      201
    )
  } catch (error) {
    return next(error)
  }
})

router.delete("/:equipmentId", async (req, res, next) => {
  try {
    const equipmentId = String(req.params.equipmentId)

    const result = await collections.favorites.deleteMany({
      customerId: { $in: idCandidates(req.user.id) },
      equipmentId: { $in: idCandidates(equipmentId) },
    })

    return ok(res, {
      equipmentId,
      removed: result.deletedCount > 0,
    })
  } catch (error) {
    return next(error)
  }
})

export default router
