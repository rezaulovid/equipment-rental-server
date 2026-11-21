import { createHash } from "node:crypto"

export function parseIdempotencyKey(value) {
  if (value === undefined) return { key: null }
  if (typeof value !== "string") {
    return { error: "Idempotency-Key must be a string." }
  }

  const key = value.trim()
  if (key.length < 1 || key.length > 128) {
    return { error: "Idempotency-Key must be between 1 and 128 characters." }
  }

  return { key }
}

export function bookingRequestFingerprint(input) {
  const fields = {
    equipmentId: input.equipmentId.toLowerCase(),
    startDate: input.startDate.toISOString(),
    endDate: input.endDate.toISOString(),
    quantity: input.quantity,
    contactNumber: input.contactNumber,
    deliveryAddress: input.deliveryAddress,
    notes: input.notes,
  }

  return createHash("sha256").update(JSON.stringify(fields)).digest("hex")
}
