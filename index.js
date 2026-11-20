import "dotenv/config"
import cors from "cors"
import express from "express"

import { collections } from "./lib/db.js"
import { normalizeUser } from "./lib/normalize.js"
import { verifyAdmin, verifyToken } from "./middleware/auth.js"
import adminRouter from "./routes/admin.js"
import bookingsRouter from "./routes/bookings.js"
import catalogRouter from "./routes/catalog.js"
import customerRouter from "./routes/customer.js"
import favoritesRouter from "./routes/favorites.js"
import ownerRouter from "./routes/owner.js"
import paymentsRouter, { handleStripeWebhook } from "./routes/payments.js"
import reviewsRouter from "./routes/reviews.js"

const app = express()
const port = Number(process.env.PORT ?? 5000)

const allowedOrigins = [
  "http://localhost:3000",
  ...(process.env.CLIENT_URL ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
]

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin/server-to-server requests have no Origin header.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true)
      }
      return callback(null, false)
    },
  })
)
// Stripe needs the untouched request body to verify the webhook signature, so
// this route is registered before the JSON body parser.
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  handleStripeWebhook
)

app.use(express.json({ limit: "1mb" }))

app.get("/", (_req, res) => {
  res.json({ success: true, service: "equipment-rental-server" })
})

app.get("/health", (_req, res) => {
  res.json({ success: true, status: "ok", uptime: process.uptime() })
})

app.get("/users",verifyToken,verifyAdmin, async (_req, res, next) => {
  try {
    const docs = await collections.users
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray()

    return res.json({
      success: true,
      message: "Users retrieved successfully",
      data: docs.map(normalizeUser),
    })
  } catch (error) {
    return next(error)
  }
})

app.use("/api/admin", adminRouter)
app.use("/api/equipment", catalogRouter)
app.use("/api/favorites", favoritesRouter)
app.use("/api/customer", customerRouter)
app.use("/api/bookings", bookingsRouter)
app.use("/api/owner", ownerRouter)
app.use("/api/payments", paymentsRouter)
app.use("/api/reviews", reviewsRouter)

app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Route not found." })
})

// Central error handler so failed queries never leak stack traces.
app.use((error, _req, res, next) => {
  console.error("[api]", error)

  if (res.headersSent) return next(error)

  const status = Number(error.status) >= 400 ? Number(error.status) : 500

  return res.status(status).json({
    success: false,
    message:
      status < 500
        ? error.message
        : "Something went wrong on the server.",
  })
})

app.listen(port, () => {
  console.log(`equipment-rental-server listening on port ${port}`)
})
