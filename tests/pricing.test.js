import assert from "node:assert/strict"
import test from "node:test"

import { parseDate, validateRentalDates } from "../lib/pricing.js"

test("date-only values reject impossible calendar dates and invalid formats", () => {
  assert.equal(parseDate("2026-02-28")?.toISOString(), "2026-02-28T00:00:00.000Z")
  assert.equal(parseDate("2026-02-29"), null)
  assert.equal(parseDate("2024-02-29")?.toISOString(), "2024-02-29T00:00:00.000Z")
  assert.equal(parseDate("2026-13-01"), null)
  assert.equal(parseDate("03/10/2026"), null)
})

test("ISO timestamps require valid calendar, time, and timezone components", () => {
  assert.equal(
    parseDate("2026-03-10T12:30:00Z")?.toISOString(),
    "2026-03-10T12:30:00.000Z"
  )
  assert.equal(parseDate("2026-03-10T24:00:00Z"), null)
  assert.equal(parseDate("2026-03-10T12:30:00"), null)
  assert.equal(parseDate("2026-02-30T12:30:00Z"), null)
})

test("rental date validation rejects invalid values and non-increasing periods", () => {
  const now = new Date("2026-03-01T12:00:00.000Z")

  assert.equal(validateRentalDates("2026-02-31", "2026-03-03", now).valid, false)
  assert.equal(validateRentalDates("2026-03-02", "2026-03-02", now).valid, false)
  assert.equal(validateRentalDates("2026-03-02", "2026-03-03", now).valid, true)
})
