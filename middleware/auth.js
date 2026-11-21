import { createRemoteJWKSet, jwtVerify } from "jose"
import { ObjectId } from "mongodb"

import { collections } from "../lib/db.js"
import { isAccountSuspended } from "../lib/normalize.js"

const issuer = process.env.BETTER_AUTH_URL

if (!issuer) {
  throw new Error(
    "BETTER_AUTH_URL is missing. It must match the BetterAuth base URL so JWTs can be verified."
  )
}

const jwks = createRemoteJWKSet(new URL(`${issuer}/api/auth/jwks`))

const respond = (res, status, message) =>
  res.status(status).json({ success: false, message })

/**
 * Verifies the Bearer access token issued by BetterAuth's JWT plugin, then
 * loads the user from MongoDB.
 *
 * The role is read from the database, never from the token or the request
 * body. A token issued before a role change therefore loses its privileges
 * immediately instead of keeping them until it expires.
 */
export async function verifyToken(req, res, next) {
  const header = req.headers.authorization ?? ""
  const [scheme, token] = header.split(" ")

  if (scheme !== "Bearer" || !token) {
    return respond(res, 401, "Authentication required.")
  }

  let payload
  try {
    const verified = await jwtVerify(token, jwks, {
      issuer,
      audience: issuer,
    })
    payload = verified.payload
  } catch {
    return respond(res, 401, "Invalid or expired access token.")
  }

  if (!payload.sub || !ObjectId.isValid(payload.sub)) {
    return respond(res, 401, "Invalid access token.")
  }

  const user = await collections.users.findOne(
    { _id: new ObjectId(payload.sub) },
    {
      projection: {
        name: 1,
        email: 1,
        image: 1,
        role: 1,
        phone: 1,
        address: 1,
        banned: 1,
        banExpires: 1,
      },
    }
  )

  if (!user) {
    return respond(res, 401, "Account not found.")
  }

  if (isAccountSuspended(user)) {
    return respond(res, 403, "This account is suspended.")
  }

  req.user = {
    id: user._id.toString(),
    name: user.name ?? "",
    email: user.email ?? "",
    image: user.image ?? null,
    phone: user.phone ?? null,
    address: user.address ?? null,
    role: user.role ?? "customer",
  }

  return next()
}

export function verifyAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return respond(res, 403, "Admin access required.")
  }

  return next()
}

/**
 * Owner-only guard for the owner dashboard. Admins keep their own area and
 * customers rent equipment, so neither may reach owner data.
 */
export function verifyOwner(req, res, next) {
  if (req.user?.role !== "owner") {
    return respond(res, 403, "Owner access required.")
  }

  return next()
}

/**
 * Customer-only guard for the renter dashboard. Owners and admins have their
 * own areas and must not reach customer booking, favorite or profile APIs.
 */
export function verifyRenter(req, res, next) {
  if (req.user?.role !== "customer") {
    return respond(res, 403, "Customer access required.")
  }

  return next()
}
