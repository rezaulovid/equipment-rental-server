import assert from "node:assert/strict"
import test from "node:test"

import {
  isSupportedRentalType,
  normalizeRentalType,
} from "../lib/normalize.js"

test("rental type validation accepts supported values and legacy aliases", () => {
  for (const value of ["daily", "day", "weekly", "week", "monthly", "month"]) {
    assert.equal(isSupportedRentalType(value), true)
  }
})

test("rental type validation rejects values normalization would default", () => {
  for (const value of ["", "hourly", "fortnightly", null]) {
    assert.equal(isSupportedRentalType(value), false)
  }
  assert.equal(normalizeRentalType("hourly"), "daily")
})
