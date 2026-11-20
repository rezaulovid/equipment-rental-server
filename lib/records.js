import { ObjectId } from "mongodb"
import { randomUUID } from "node:crypto"

import { collections } from "./db.js"
import { maximumConcurrentReservedQuantity, toId } from "./normalize.js"

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

export function bookingLifecycleFilter(booking) {
  const filter = {}

  for (const field of ["bookingStatus", "status"]) {
    filter[field] =
      booking[field] === undefined
        ? { $exists: false }
        : { $eq: booking[field], $exists: true }
  }

  return filter
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

export async function acquireEquipmentReservationLock(equipmentId) {
  const token = randomUUID()
  const now = new Date()
  const result = await collections.equipment.updateOne(
    {
      _id: { $in: idCandidates(equipmentId) },
      $or: [
        { reservationLockExpiresAt: { $exists: false } },
        { reservationLockExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        reservationLockToken: token,
        reservationLockExpiresAt: new Date(now.getTime() + 2 * 60 * 1000),
      },
    }
  )

  return result.modifiedCount === 1 ? token : null
}

export async function releaseEquipmentReservationLock(equipmentId, token) {
  await collections.equipment.updateOne(
    {
      _id: { $in: idCandidates(equipmentId) },
      reservationLockToken: token,
    },
    {
      $unset: {
        reservationLockToken: "",
        reservationLockExpiresAt: "",
      },
    }
  )
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
        $or: [
          { checkoutExpiresAt: { $gte: new Date() } },
          {
            checkoutExpiresAt: { $exists: false },
            createdAt: { $gte: new Date(Date.now() - 35 * 60 * 1000) },
          },
        ],
      },
    ],
  }
}

export async function maximumReservedQuantity(equipmentId) {
  const now = new Date()
  const bookings = await collections.bookings
    .find(
      {
        ...inventoryHoldFilter(equipmentId),
        endDate: { $gt: now },
      },
      { projection: { startDate: 1, endDate: 1, quantity: 1 } }
    )
    .toArray()

  return maximumConcurrentReservedQuantity(bookings, now)
}
