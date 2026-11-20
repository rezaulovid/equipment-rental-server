export function parsePagination(
  query,
  { defaultLimit = 24, maxLimit = 100 } = {}
) {
  const pageProvided = query.page !== undefined && query.page !== ""
  const limitProvided = query.limit !== undefined && query.limit !== ""
  const page = pageProvided ? Number(query.page) : 1
  const limit = limitProvided
    ? Number(query.limit)
    : pageProvided
      ? defaultLimit
      : undefined

  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) {
    return { error: "Page must be a whole number between 1 and 1000000." }
  }

  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > maxLimit)
  ) {
    return {
      error: `Limit must be a whole number between 1 and ${maxLimit}.`,
    }
  }

  return {
    page,
    limit,
    skip: limit === undefined ? 0 : (page - 1) * limit,
    requested: pageProvided || limitProvided,
  }
}
