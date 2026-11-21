/**
 * Rental pricing rules shared by the booking and payment routes.
 *
 * The server always recalculates money from trusted database values. The
 * frontend estimate is display-only and is never used to create a payment.
 */

const MS_PER_DAY = 86_400_000

const RENTAL_TYPES = ["daily", "weekly", "monthly"]

const ALIASES = {
  day: "daily",
  daily: "daily",
  week: "weekly",
  weekly: "weekly",
  month: "monthly",
  monthly: "monthly",
}

export function normalizeRentalType(value) {
  return ALIASES[String(value ?? "").toLowerCase()] ?? "daily"
}

/** Parses a `YYYY-MM-DD` value (or ISO string) as a UTC calendar date. */
export function parseDate(value) {
  if (!value) return null

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  const text = String(value).trim()
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  const isoTimestamp =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(
      text
    )

  if (dateOnly || isoTimestamp) {
    const match = dateOnly ?? isoTimestamp
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const calendarDate = new Date(0)
    calendarDate.setUTCHours(0, 0, 0, 0)
    calendarDate.setUTCFullYear(year, month - 1, day)

    if (
      calendarDate.getUTCFullYear() !== year ||
      calendarDate.getUTCMonth() !== month - 1 ||
      calendarDate.getUTCDate() !== day
    ) {
      return null
    }

    if (dateOnly) return calendarDate

    const hour = Number(match[4])
    const minute = Number(match[5])
    const second = Number(match[6] ?? 0)
    const offset = match[8]
    if (
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      (offset.toUpperCase() !== "Z" &&
        (Number(offset.slice(1, 3)) > 23 ||
          Number(offset.slice(4, 6)) > 59))
    ) {
      return null
    }

    const timestamp = new Date(text)
    return Number.isNaN(timestamp.getTime()) ? null : timestamp
  }

  return null
}

export function startOfUtcDay(date = new Date()) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  )
}

export function rentalDurationDays(startDate, endDate) {
  const start = parseDate(startDate)
  const end = parseDate(endDate)

  if (!start || !end) return 0

  const days = Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY)
  return days > 0 ? days : 0
}

/** Number of billable pricing units for a rental period. */
export function billableUnits(durationDays, rentalType) {
  const days = Math.max(0, Math.ceil(Number(durationDays) || 0))
  if (days === 0) return 0

  switch (normalizeRentalType(rentalType)) {
    case "weekly":
      return Math.ceil(days / 7)
    case "monthly":
      return Math.ceil(days / 30)
    default:
      return days
  }
}

/**
 * Calculates the payable amount from the equipment price, the rental type,
 * the rental duration and the requested quantity.
 */
export function calculateRentalTotal({
  rentalPrice,
  rentalType,
  startDate,
  endDate,
  quantity,
}) {
  const durationDays = rentalDurationDays(startDate, endDate)
  const units = billableUnits(durationDays, rentalType)
  const price = Number(rentalPrice)
  const qty = Math.max(0, Math.floor(Number(quantity) || 0))
  const unitPrice = Number.isFinite(price) && price > 0 ? price : 0
  const totalAmount =
    Math.round(unitPrice * units * qty * 100) / 100

  return {
    rentalType: normalizeRentalType(rentalType),
    durationDays,
    billableUnits: units,
    unitPrice,
    quantity: qty,
    totalAmount,
  }
}

export function validateRentalDates(startDate, endDate, now = new Date()) {
  const start = parseDate(startDate)
  const end = parseDate(endDate)

  if (!start) return { valid: false, message: "Choose a valid rental start date." }
  if (!end) return { valid: false, message: "Choose a valid rental end date." }

  if (start.getTime() < startOfUtcDay(now).getTime()) {
    return { valid: false, message: "Rental start date cannot be in the past." }
  }

  if (end.getTime() <= start.getTime()) {
    return {
      valid: false,
      message: "Rental end date must be after the start date.",
    }
  }

  return { valid: true, startDate: start, endDate: end }
}

export function formatRentalPeriod(rentalType) {
  const type = normalizeRentalType(rentalType)
  return type === "weekly" ? "week" : type === "monthly" ? "month" : "day"
}

export { RENTAL_TYPES }
