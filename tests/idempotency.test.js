import assert from "node:assert/strict"
import test from "node:test"

import {
  bookingRequestFingerprint,
  parseIdempotencyKey,
} from "../lib/idempotency.js"

test("idempotency keys are optional for existing clients", () => {
  assert.deepEqual(parseIdempotencyKey(undefined), { key: null })
})

test("idempotency keys are trimmed and bounded", () => {
  assert.deepEqual(parseIdempotencyKey("  request-123  "), {
    key: "request-123",
  })
  assert.match(parseIdempotencyKey("").error, /between 1 and 128/)
  assert.match(parseIdempotencyKey("x".repeat(129)).error, /between 1 and 128/)
})

test("booking fingerprints are stable and change with rental details", () => {
  const input = {
    equipmentId: "ABCDEF0123456789ABCDEF01",
    startDate: new Date("2026-03-02T00:00:00.000Z"),
    endDate: new Date("2026-03-04T00:00:00.000Z"),
    quantity: 2,
    contactNumber: "+1 555 0100",
    deliveryAddress: "10 Main Street",
    notes: "",
  }

  assert.equal(bookingRequestFingerprint(input), bookingRequestFingerprint(input))
  assert.notEqual(
    bookingRequestFingerprint(input),
    bookingRequestFingerprint({ ...input, quantity: 3 })
  )
})
