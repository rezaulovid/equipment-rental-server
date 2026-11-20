import assert from "node:assert/strict"
import test from "node:test"

import { parsePagination } from "../lib/pagination.js"

test("pagination is opt-in and preserves unpaginated catalogue requests", () => {
  assert.deepEqual(parsePagination({}), {
    page: 1,
    limit: undefined,
    skip: 0,
    requested: false,
  })
})

test("page-only requests use the configured default limit", () => {
  assert.deepEqual(parsePagination({ page: "3" }), {
    page: 3,
    limit: 24,
    skip: 48,
    requested: true,
  })
})

test("explicit limit and page calculate a stable skip", () => {
  assert.deepEqual(parsePagination({ page: "4", limit: "10" }), {
    page: 4,
    limit: 10,
    skip: 30,
    requested: true,
  })
})

test("invalid page and limit values are rejected", () => {
  assert.match(parsePagination({ page: "0" }).error, /Page must be/)
  assert.match(parsePagination({ limit: "101" }).error, /Limit must be/)
})

test("review pagination uses its smaller response default and cap", () => {
  assert.deepEqual(
    parsePagination({ page: "2" }, { defaultLimit: 8, maxLimit: 50 }),
    {
      page: 2,
      limit: 8,
      skip: 8,
      requested: true,
    }
  )
  assert.match(
    parsePagination({ limit: "51" }, { defaultLimit: 8, maxLimit: 50 }).error,
    /Limit must be/
  )
})
