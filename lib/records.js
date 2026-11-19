import { ObjectId } from "mongodb"

import { collections } from "./db.js"
import { toId } from "./normalize.js"

/**
 * Documents in this project were written by several different flows over
 * time, so ids can be stored as strings or ObjectIds. These helpers let a
 * query match either representation without leaking that detail into routes.
 */
export function idCandidates(value) {
  const raw = toId(value)
  if (!raw) return []

  const candidates = [raw]
  if (ObjectId.isValid(raw)) candidates.push(new ObjectId(raw))
  return candidates
}

export function byIdFilter(value) {
  return { _id: { $in: idCandidates(value) } }
}

export function equipmentByIdFilter(value) {
  return byIdFilter(value)
}

export function customerOwnershipFilter(customerId) {
  const ids = idCandidates(customerId)
  return { $or: [{ customerId: { $in: ids } }, { userId: { $in: ids } }] }
}

export async function loadEquipmentMap(ids) {
  const unique = [...new Set(ids.map(toId).filter(Boolean))]
  if (unique.length === 0) return new Map()

  const candidates = unique.flatMap(idCandidates)
  const docs = await collections.equipment
    .find({ _id: { $in: candidates } })
    .toArray()

  return new Map(docs.map((doc) => [toId(doc._id), doc]))
}

export async function loadBookingsMap(ids) {
  const unique = [...new Set(ids.map(toId).filter(Boolean))]
  if (unique.length === 0) return new Map()

  const docs = await collections.bookings
    .find({ _id: { $in: unique.flatMap(idCandidates) } })
    .toArray()

  return new Map(docs.map((doc) => [toId(doc._id), doc]))
}

/**
 * Bookings that still hold inventory. A pending Stripe Checkout only holds
 * stock for a short window so abandoned payments cannot block a rental
 * forever. Paid bookings always hold stock.
 */
export function inventoryHoldFilter(equipmentId) {
  return {
    equipmentId: { $in: idCandidates(equipmentId) },
    bookingStatus: { $in: ["pending", "active"] },
    $or: [
      { paymentStatus: "paid" },
      {
        paymentStatus: { $in: ["pending", "unpaid"] },
        createdAt: { $gte: new Date(Date.now() - 35 * 60 * 1000) },
      },
    ],
  }
}
