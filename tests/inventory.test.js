import assert from "node:assert/strict"
import test from "node:test"

import { maximumConcurrentReservedQuantity } from "../lib/normalize.js"

const now = new Date("2026-01-01T00:00:00.000Z")

test("reserved quantity is the maximum concurrent overlap, not total bookings", () => {
  const bookings = [
    {
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-01-03T00:00:00.000Z",
      quantity: 2,
    },
    {
      startDate: "2026-01-02T00:00:00.000Z",
      endDate: "2026-01-04T00:00:00.000Z",
      quantity: 3,
    },
    {
      startDate: "2026-01-05T00:00:00.000Z",
      endDate: "2026-01-06T00:00:00.000Z",
      quantity: 4,
    },
  ]

  assert.equal(maximumConcurrentReservedQuantity(bookings, now), 5)
})

test("reservation intervals are half-open and expired or invalid records are ignored", () => {
  const bookings = [
    {
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-01-02T00:00:00.000Z",
      quantity: 2,
    },
    {
      startDate: "2026-01-02T00:00:00.000Z",
      endDate: "2026-01-03T00:00:00.000Z",
      quantity: 3,
    },
    {
      startDate: "2025-12-01T00:00:00.000Z",
      endDate: "2025-12-02T00:00:00.000Z",
      quantity: 100,
    },
    { startDate: "invalid", endDate: "2026-01-04T00:00:00.000Z", quantity: 9 },
  ]

  assert.equal(maximumConcurrentReservedQuantity(bookings, now), 3)
})
