/** Shared shaping helpers for admin responses. */

const RENTAL_TYPE_ALIASES = {
  day: "daily",
  daily: "daily",
  week: "weekly",
  weekly: "weekly",
  month: "monthly",
  monthly: "monthly",
}

export const EQUIPMENT_STATUSES = ["pending", "approved", "rejected"]
export const USER_ROLES = ["customer", "owner", "admin"]
export const PAYMENT_STATUSES = ["unpaid", "pending", "paid", "refunded", "failed"]
export const BOOKING_STATUSES = [
  "pending",
  "active",
  "completed",
  "cancelled",
]

/** Allowed administrative status transitions; terminal states stay terminal. */
export const BOOKING_TRANSITIONS = {
  pending: ["active", "cancelled"],
  active: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
}

export const isSupportedRentalType = (value) =>
  Object.hasOwn(RENTAL_TYPE_ALIASES, String(value ?? "").trim().toLowerCase())

export const toId = (value) => {
  if (!value) return ""
  if (typeof value === "string") return value
  if (typeof value.toHexString === "function") return value.toHexString()
  return String(value)
}

export const toIso = (value) => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export const toNumber = (value, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function maximumConcurrentReservedQuantity(bookings, now = new Date()) {
  const events = []
  const from = now.getTime()

  for (const booking of bookings) {
    const start = new Date(booking.startDate).getTime()
    const end = new Date(booking.endDate).getTime()
    const quantity = toNumber(booking.quantity, 1)

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= from) {
      continue
    }
    if (quantity <= 0) continue

    events.push(
      { time: Math.max(start, from), change: quantity },
      { time: end, change: -quantity }
    )
  }

  events.sort((left, right) => left.time - right.time || left.change - right.change)

  let reserved = 0
  let maximum = 0
  for (const event of events) {
    reserved += event.change
    maximum = Math.max(maximum, reserved)
  }

  return maximum
}

export function normalizeRentalType(value) {
  if (!value) return "daily"
  return RENTAL_TYPE_ALIASES[String(value).toLowerCase()] ?? "daily"
}

export function normalizeRole(value) {
  const role = String(value ?? "").toLowerCase()
  return USER_ROLES.includes(role) ? role : "customer"
}

export function normalizeEquipment(doc, owners = {}) {
  const ownerFromDoc = doc.owner && typeof doc.owner === "object" ? doc.owner : null
  const ownerId = toId(doc.ownerId ?? doc.owner?._id ?? ownerFromDoc?._id)
  const owner = ownerId ? owners[ownerId] : null

  return {
    id: toId(doc._id),
    name: doc.name ?? doc.title ?? "Untitled equipment",
    description: doc.description ?? "",
    category: doc.category ?? "Uncategorized",
    location: doc.location ?? "",
    rentalPrice: toNumber(doc.rentalPrice ?? doc.price),
    rentalType: normalizeRentalType(doc.rentalType ?? doc.rentalPeriod),
    availableQuantity: toNumber(doc.availableQuantity ?? doc.quantity),
    condition: doc.condition ?? "",
    brand: doc.brand ?? "",
    model: doc.model ?? "",
    image:
      doc.image ??
      (Array.isArray(doc.images) ? doc.images[0] : "") ??
      "",
    terms: doc.terms ?? doc.rentalTerms ?? "",
    status: [undefined, null, ""].includes(doc.status)
      ? "pending"
      : String(doc.status).toLowerCase(),
    ownerId,
    ownerName:
      doc.ownerName ?? doc.owner?.name ?? owner?.name ?? "Unknown owner",
    ownerEmail: doc.ownerEmail ?? doc.owner?.email ?? owner?.email ?? "",
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  }
}

export function normalizeUser(doc) {
  return {
    id: toId(doc._id),
    name: doc.name ?? "Unnamed user",
    email: doc.email ?? "",
    role: normalizeRole(doc.role),
    image: doc.image ?? null,
    phone: doc.phone ?? "",
    address: doc.address ?? "",
    banned: Boolean(doc.banned),
    createdAt: toIso(doc.createdAt),
  }
}

export function rentalDurationDays(startDate, endDate) {
  const start = startDate ? new Date(startDate) : null
  const end = endDate ? new Date(endDate) : null

  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 0
  }

  const days = Math.ceil((end.getTime() - start.getTime()) / 86_400_000)
  return days > 0 ? days : 0
}

export function normalizeBooking(doc, customers = {}, owners = {}) {
  const customerId = toId(doc.customerId ?? doc.customer?._id ?? doc.userId)
  const ownerId = toId(doc.ownerId ?? doc.owner?._id)
  const customer = customerId ? customers[customerId] : null
  const owner = ownerId ? owners[ownerId] : null
  const paymentStatus = String(doc.paymentStatus ?? "unpaid").toLowerCase()

  return {
    id: toId(doc._id),
    equipmentId: toId(doc.equipmentId),
    equipmentName: doc.equipmentName ?? doc.equipment?.name ?? "Deleted equipment",
    equipmentImage:
      doc.equipmentImage ??
      doc.equipment?.image ??
      (Array.isArray(doc.equipment?.images) ? doc.equipment.images[0] : "") ??
      "",
    customerId,
    customerName:
      doc.customerName ?? doc.customer?.name ?? customer?.name ?? "Unknown customer",
    customerEmail:
      doc.customerEmail ?? doc.customer?.email ?? customer?.email ?? "",
    ownerId,
    ownerName: doc.ownerName ?? doc.owner?.name ?? owner?.name ?? "Unknown owner",
    ownerEmail: doc.ownerEmail ?? doc.owner?.email ?? owner?.email ?? "",
    startDate: toIso(doc.startDate),
    endDate: toIso(doc.endDate),
    durationDays:
      toNumber(doc.durationDays ?? doc.rentalDays) ||
      rentalDurationDays(doc.startDate, doc.endDate),
    billableUnits: toNumber(doc.billableUnits, 0),
    rentalType: normalizeRentalType(doc.rentalType),
    unitPrice: toNumber(doc.unitPrice, 0),
    quantity: toNumber(doc.quantity, 1),
    contactNumber: doc.contactNumber ?? "",
    deliveryAddress: doc.deliveryAddress ?? "",
    notes: doc.notes ?? "",
    totalAmount: toNumber(doc.totalAmount ?? doc.amount),
    paymentStatus: PAYMENT_STATUSES.includes(paymentStatus)
      ? paymentStatus
      : "unpaid",
    bookingStatus: BOOKING_STATUSES.includes(
      String(doc.bookingStatus ?? doc.status ?? "").toLowerCase()
    )
      ? String(doc.bookingStatus ?? doc.status).toLowerCase()
      : "pending",
    createdAt: toIso(doc.createdAt),
  }
}

export function normalizePayment(doc, bookings = {}) {
  const bookingId = toId(doc.bookingId)
  const booking = bookingId ? bookings[bookingId] : null
  const status = String(doc.status ?? "pending").toLowerCase()

  return {
    id: toId(doc._id),
    bookingId,
    equipmentId: toId(doc.equipmentId ?? booking?.equipmentId),
    equipmentName:
      doc.equipmentName ?? booking?.equipmentName ?? "Deleted equipment",
    customerId: toId(doc.customerId),
    amount: toNumber(doc.amount),
    currency: String(doc.currency ?? "usd").toUpperCase(),
    status: PAYMENT_STATUSES.includes(status) ? status : "pending",
    method: doc.method ?? "stripe",
    transactionId: doc.transactionId ?? "",
    receiptUrl: doc.receiptUrl ?? "",
    paidAt: toIso(doc.paidAt),
    createdAt: toIso(doc.createdAt),
  }
}
