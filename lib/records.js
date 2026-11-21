import { ObjectId } from "mongodb"
import { randomUUID } from "node:crypto"

import { collections } from "./db.js"
import { maximumConcurrentReservedQuantity, toId } from "./normalize.js"

const RESERVATION_LOCK_TTL_MS = 2 * 60 * 1000
const RESERVATION_LOCK_RENEWAL_MS = 30 * 1000

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
        reservationLockExpiresAt: new Date(
          now.getTime() + RESERVATION_LOCK_TTL_MS
        ),
      },
    }
  )

  return result.modifiedCount === 1 ? token : null
}

async function renewEquipmentReservationLock(equipmentId, token) {
  const now = new Date()
  const result = await collections.equipment.updateOne(
    {
      _id: { $in: idCandidates(equipmentId) },
      reservationLockToken: token,
      reservationLockExpiresAt: { $gt: now },
    },
    {
      $set: {
        reservationLockExpiresAt: new Date(
          now.getTime() + RESERVATION_LOCK_TTL_MS
        ),
      },
    }
  )

  return result.matchedCount === 1
}

export function startEquipmentReservationLockHeartbeat(equipmentId, token) {
  let lost = false
  let stopped = false
  let renewalPromise = null

  const renew = () => {
    if (renewalPromise) return renewalPromise
    renewalPromise = (async () => {
      try {
        if (!(await renewEquipmentReservationLock(equipmentId, token))) {
          lost = true
        }
      } catch (error) {
        lost = true
        console.error("[inventory] reservation lock renewal failed:", error)
      } finally {
        renewalPromise = null
      }
    })()
    return renewalPromise
  }

  const timer = setInterval(() => {
    if (!stopped && !lost) void renew()
  }, RESERVATION_LOCK_RENEWAL_MS)
  timer.unref?.()

  return {
    async assertOwned() {
      if (stopped || lost) {
        const error = new Error("The equipment reservation lock was lost.")
        error.status = 409
        throw error
      }

      await renew()
      if (lost) {
        const error = new Error("The equipment reservation lock was lost.")
        error.status = 409
        throw error
      }
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      if (renewalPromise) await renewalPromise
    },
  }
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
  const equipmentIds = Array.isArray(equipmentId)
    ? equipmentId.flatMap(idCandidates)
    : idCandidates(equipmentId)

  return {
    equipmentId: { $in: equipmentIds },
    $and: [
      {
        $or: [
          { bookingStatus: { $in: ["pending", "active"] } },
          {
            bookingStatus: { $in: [null, ""] },
            $or: [
              { status: { $in: ["pending", "active"] } },
              { status: { $in: [null, ""] } },
            ],
          },
        ],
      },
      {
        $or: [
          { paymentStatus: "paid" },
          {
            paymentStatus: { $in: ["pending", "unpaid", null] },
            $or: [
              { checkoutExpiresAt: { $gte: new Date() } },
              {
                checkoutExpiresAt: { $exists: false },
                createdAt: { $gte: new Date(Date.now() - 35 * 60 * 1000) },
              },
            ],
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
