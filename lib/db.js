import "dotenv/config"
import { MongoClient } from "mongodb"

/**
 * Single Mongo connection shared by every route.
 *
 * `MONGODB_URI` wins when present (Atlas SRV strings differ per deployment);
 * otherwise the credentials already used by this project are assembled here.
 */
const uri =
  process.env.MONGODB_URI ??
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ciwub8g.mongodb.net/`

export const client = new MongoClient(uri)

await client.connect()
console.log("MongoDB connected")

/**
 * BetterAuth writes the `user` collection into this database, so the server
 * must read from the same one. Keep the name in a single place.
 */
export const db = client.db(process.env.DB_NAME ?? "rentalAdmindb")

export const collections = {
  users: db.collection("user"),
  equipment: db.collection("equipment"),
  bookings: db.collection("bookings"),
  payments: db.collection("payments"),
  favorites: db.collection("favorites"),
  reviews: db.collection("reviews"),
  webhookEvents: db.collection("stripeWebhookEvents"),
}

function supportsTransactions() {
  return ["ReplicaSetWithPrimary", "Sharded", "LoadBalanced"].includes(
    client.topology?.description?.type
  )
}

function isUnsupportedTransactionError(error) {
  return (
    [20, 303].includes(error?.code) ||
    /Transaction numbers are only allowed|does not support transactions/i.test(
      error?.message ?? ""
    )
  )
}

/**
 * Use a MongoDB transaction when the connected topology supports it. A
 * standalone server falls back to the caller's idempotent sequential writes.
 */
export async function withOptionalTransaction(operation) {
  if (!supportsTransactions()) return operation(null)

  const session = client.startSession()
  try {
    let result
    await session.withTransaction(async () => {
      result = await operation(session)
      return result
    })
    return result
  } catch (error) {
    if (!isUnsupportedTransactionError(error)) throw error
    console.warn(
      "[db] transactions are unavailable; using idempotent sequential writes:",
      error.message
    )
    return operation(null)
  } finally {
    await session.endSession()
  }
}

/**
 * Indexes that the customer features depend on. Creating them here keeps the
 * guarantees (one favorite per customer/equipment, fast ownership queries)
 * close to the collection definitions.
 */
await Promise.all([
  collections.favorites
    .createIndex({ customerId: 1, equipmentId: 1 }, { unique: true })
    .catch((error) =>
      console.warn("[db] favorites index:", error.message)
    ),
  collections.bookings
    .createIndex({ customerId: 1, createdAt: -1 })
    .catch((error) => console.warn("[db] bookings index:", error.message)),
  collections.bookings
    .createIndex({ ownerId: 1, createdAt: -1 })
    .catch((error) => console.warn("[db] owner bookings index:", error.message)),
  collections.bookings
    .createIndex({ equipmentId: 1, bookingStatus: 1, startDate: 1 })
    .catch((error) =>
      console.warn("[db] equipment availability index:", error.message)
    ),
  collections.bookings
    .createIndex(
      { customerId: 1, idempotencyKey: 1 },
      {
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: "string" } },
      }
    )
    .catch((error) =>
      console.warn("[db] booking idempotency index:", error.message)
    ),
  collections.equipment
    .createIndex({ ownerId: 1, createdAt: -1 })
    .catch((error) => console.warn("[db] owner equipment index:", error.message)),
  collections.payments
    .createIndex({ customerId: 1, createdAt: -1 })
    .catch((error) => console.warn("[db] payments index:", error.message)),
  collections.payments
    .createIndex({ stripeSessionId: 1 })
    .catch((error) => console.warn("[db] payments session index:", error.message)),
  collections.webhookEvents
    .createIndex({ eventId: 1 }, { unique: true })
    .catch((error) => console.warn("[db] webhook index:", error.message)),
  collections.reviews.createIndex({ bookingId: 1 }, { unique: true }),
  collections.reviews.createIndex({ status: 1, createdAt: -1 }),
  collections.reviews.createIndex({ equipmentId: 1, status: 1, createdAt: -1 }),
])
