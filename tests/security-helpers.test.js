import assert from "node:assert/strict"
import test from "node:test"

import {
  isAccountSuspended,
  normalizeEquipment,
} from "../lib/normalize.js"

test("invalid or absent ban expiries do not silently release a suspension", () => {
  const now = Date.parse("2026-03-01T00:00:00.000Z")

  assert.equal(isAccountSuspended({ banned: true }, now), true)
  assert.equal(isAccountSuspended({ banned: true, banExpires: "invalid" }, now), true)
  assert.equal(
    isAccountSuspended({ banned: true, banExpires: "2026-03-02T00:00:00.000Z" }, now),
    true
  )
  assert.equal(
    isAccountSuspended({ banned: true, banExpires: "2026-02-28T00:00:00.000Z" }, now),
    false
  )
  assert.equal(isAccountSuspended({ banned: false }, now), false)
})

test("public equipment serialization keeps the field but withholds owner email", () => {
  const equipment = normalizeEquipment(
    {
      _id: "equipment-1",
      ownerId: "owner-1",
      ownerEmail: "private@example.test",
      status: "approved",
    },
    {},
    { includeOwnerEmail: false }
  )

  assert.equal(equipment.ownerEmail, "")
})
