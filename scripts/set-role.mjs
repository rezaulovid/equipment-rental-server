import "dotenv/config"
import { MongoClient } from "mongodb"

/**
 * Promotes (or demotes) an existing account.
 *
 *   npm run set-role -- user@example.com admin
 *   npm run set-role -- user@example.com owner
 */

const [email, role = "admin"] = process.argv.slice(2)
const allowed = ["customer", "owner", "admin"]

if (!email) {
  console.error("Usage: npm run set-role -- <email> <customer|owner|admin>")
  process.exit(1)
}

if (!allowed.includes(role)) {
  console.error(`Role must be one of: ${allowed.join(", ")}`)
  process.exit(1)
}

const uri =
  process.env.MONGODB_URI ??
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ciwub8g.mongodb.net/`

const client = new MongoClient(uri)

try {
  await client.connect()
  const db = client.db(process.env.DB_NAME ?? "rentalAdmindb")
  const result = await db
    .collection("user")
    .updateOne({ email }, { $set: { role, updatedAt: new Date() } })

  if (result.matchedCount === 0) {
    console.error(`No account found for ${email}.`)
    process.exitCode = 1
  } else {
    console.log(`${email} is now ${role}.`)
  }
} catch (error) {
  console.error("Failed:", error.message)
  process.exitCode = 1
} finally {
  await client.close()
}
