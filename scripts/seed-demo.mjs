import "dotenv/config"
import { MongoClient } from "mongodb"

/**
 * Optional demo dataset for the admin dashboard.
 *
 *   npm run seed            inserts only when equipment/bookings are empty
 *   npm run seed -- --force wipes and re-inserts the demo records
 *
 * It never creates users — it reuses the accounts already registered through
 * BetterAuth and only writes equipment, bookings and payments.
 */

const uri =
  process.env.MONGODB_URI ??
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ciwub8g.mongodb.net/`

const client = new MongoClient(uri)
const force = process.argv.includes("--force")

try {
  await client.connect()
  const db = client.db(process.env.DB_NAME ?? "rentalAdmindb")

  const users = await db
    .collection("user")
    .find({}, { projection: { name: 1, email: 1, role: 1 } })
    .limit(8)
    .toArray()

  if (users.length === 0) {
    throw new Error("No users found. Register at least one account first.")
  }

  const existingEquipment = await db.collection("equipment").countDocuments()

  if (existingEquipment > 0 && !force) {
    console.log(
      `Equipment collection already has ${existingEquipment} document(s). Nothing inserted. Use --force to reset.`
    )
    process.exit(0)
  }

  if (force) {
    await db.collection("equipment").deleteMany({ demo: true })
    await db.collection("bookings").deleteMany({ demo: true })
    await db.collection("payments").deleteMany({ demo: true })
    console.log("Removed previous demo records.")
  }

  const admin = users.find((user) => user.email === "admin.verify@rentpro.dev") ?? users[0]
  const others = users.filter((user) => user._id.toString() !== admin._id.toString())
  const customers = others.length > 0 ? others : [admin]

  const owner = (index) => {
    const user = index === 0 ? admin : others[index % Math.max(others.length, 1)] ?? admin
    return {
      ownerId: user._id.toString(),
      ownerName: user.name,
      ownerEmail: user.email,
    }
  }

  const equipmentSeed = [
    {
      name: "CAT 320 Excavator",
      category: "Construction Equipment",
      location: "Dhaka, Bangladesh",
      rentalPrice: 320,
      rentalType: "daily",
      availableQuantity: 3,
      condition: "Excellent",
      brand: "Caterpillar",
      model: "320 GC",
      image:
        "https://images.unsplash.com/photo-1581094794329-c8112a89af12?auto=format&fit=crop&w=600&q=70",
      description:
        "20-ton tracked excavator suited to foundation work, trenching and site clearance. Operator can be arranged on request.",
      terms: "Fuel is charged separately. A valid operator licence is required.",
      status: "approved",
      createdDaysAgo: 21,
    },
    {
      name: "Canon EOS R5 Kit",
      category: "Photography Equipment",
      location: "Chattogram, Bangladesh",
      rentalPrice: 45,
      rentalType: "daily",
      availableQuantity: 2,
      condition: "Like new",
      brand: "Canon",
      model: "EOS R5",
      image:
        "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=600&q=70",
      description:
        "45MP mirrorless body with 24-70mm f/2.8 lens, two batteries and a 128GB CFexpress card.",
      terms: "A refundable security deposit is required. Damage is charged at repair cost.",
      status: "pending",
      createdDaysAgo: 4,
    },
    {
      name: "Scissor Lift 12m",
      category: "Construction Equipment",
      location: "Dhaka, Bangladesh",
      rentalPrice: 180,
      rentalType: "daily",
      availableQuantity: 1,
      condition: "Good",
      brand: "JLG",
      model: "1932R",
      image:
        "https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=600&q=70",
      description: "Electric scissor lift for indoor works up to 12 metres.",
      terms: "Indoor use only. Charging is the renter's responsibility.",
      status: "pending",
      createdDaysAgo: 2,
    },
    {
      name: "Toyota Hilux 4x4",
      category: "Vehicles & Transportation",
      location: "Sylhet, Bangladesh",
      rentalPrice: 95,
      rentalType: "daily",
      availableQuantity: 2,
      condition: "Excellent",
      brand: "Toyota",
      model: "Hilux Revo",
      image:
        "https://images.unsplash.com/photo-1551830820-330a71b99659?auto=format&fit=crop&w=600&q=70",
      description: "Double-cab pickup with 4x4, ideal for site visits and rural transport.",
      terms: "Driver must be 25+. Mileage limit 200km/day.",
      status: "approved",
      createdDaysAgo: 34,
    },
    {
      name: "DJI Mavic 3 Drone",
      category: "Electronics",
      location: "Dhaka, Bangladesh",
      rentalPrice: 70,
      rentalType: "daily",
      availableQuantity: 4,
      condition: "Good",
      brand: "DJI",
      model: "Mavic 3",
      image:
        "https://images.unsplash.com/photo-1473968512647-3e447244af8f?auto=format&fit=crop&w=600&q=70",
      description:
        "4K drone for site surveys and event coverage, supplied with three batteries and a hard case.",
      terms: "Flying in restricted airspace is not permitted.",
      status: "approved",
      createdDaysAgo: 48,
    },
    {
      name: "Mobile Stage Trailer",
      category: "Event Equipment",
      location: "Khulna, Bangladesh",
      rentalPrice: 400,
      rentalType: "weekly",
      availableQuantity: 1,
      condition: "Fair",
      brand: "StageLine",
      model: "MS-40",
      image:
        "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=600&q=70",
      description: "8m x 6m covered stage trailer with lighting rig and stairs.",
      terms: "Transport cost is charged separately. Setup crew included.",
      status: "rejected",
      createdDaysAgo: 60,
    },
  ]

  const day = 86_400_000
  const now = Date.now()

  const equipmentDocs = equipmentSeed.map((item, index) => ({
    name: item.name,
    description: item.description,
    category: item.category,
    location: item.location,
    rentalPrice: item.rentalPrice,
    rentalType: item.rentalType,
    availableQuantity: item.availableQuantity,
    condition: item.condition,
    brand: item.brand,
    model: item.model,
    image: item.image,
    terms: item.terms,
    status: item.status,
    ...owner(index),
    demo: true,
    createdAt: new Date(now - item.createdDaysAgo * day),
    updatedAt: new Date(now - item.createdDaysAgo * day + 2 * day),
  }))

  const insertedEquipment = await db.collection("equipment").insertMany(equipmentDocs)

  const equipmentIds = Object.values(insertedEquipment.insertedIds)

  const bookingSeed = [
    { equipment: 0, customer: 0, status: "completed", payment: "paid", daysAgo: 150, duration: 3, qty: 1 },
    { equipment: 3, customer: 0, status: "completed", payment: "paid", daysAgo: 120, duration: 5, qty: 1 },
    { equipment: 4, customer: 1 % customers.length, status: "completed", payment: "paid", daysAgo: 96, duration: 2, qty: 1 },
    { equipment: 0, customer: 1 % customers.length, status: "completed", payment: "paid", daysAgo: 62, duration: 1, qty: 1 },
    { equipment: 4, customer: 2 % customers.length, status: "active", payment: "paid", daysAgo: 26, duration: 4, qty: 2 },
    { equipment: 3, customer: 0, status: "active", payment: "paid", daysAgo: 14, duration: 3, qty: 1 },
    { equipment: 1, customer: 2 % customers.length, status: "pending", payment: "unpaid", daysAgo: 6, duration: 2, qty: 1 },
    { equipment: 2, customer: 1 % customers.length, status: "cancelled", payment: "unpaid", daysAgo: 40, duration: 7, qty: 1 },
  ]

  const bookingDocs = bookingSeed.map((entry, index) => {
    const item = equipmentSeed[entry.equipment]
    const customer = customers[entry.customer]
    const equipmentDoc = equipmentDocs[entry.equipment]
    const start = new Date(now - entry.daysAgo * day)
    const end = new Date(start.getTime() + entry.duration * day)

    return {
      equipmentId: equipmentIds[entry.equipment].toString(),
      equipmentName: item.name,
      customerId: customer._id.toString(),
      customerName: customer.name,
      customerEmail: customer.email,
      ownerId: equipmentDoc.ownerId,
      ownerName: equipmentDoc.ownerName,
      ownerEmail: equipmentDoc.ownerEmail,
      startDate: start,
      endDate: end,
      durationDays: entry.duration,
      quantity: entry.qty,
      contactNumber: "+880170000000" + index,
      deliveryAddress: "House 12, Road 5, Dhanmondi, Dhaka",
      notes: "",
      totalAmount: item.rentalPrice * entry.duration * entry.qty,
      paymentStatus: entry.payment,
      bookingStatus: entry.status,
      demo: true,
      createdAt: new Date(start.getTime() - 3 * day),
      updatedAt: new Date(start.getTime() + day),
    }
  })

  const insertedBookings = await db.collection("bookings").insertMany(bookingDocs)

  const paymentDocs = bookingSeed
    .map((entry, index) => {
      if (entry.payment !== "paid") return null
      const booking = bookingDocs[index]
      const bookingId = insertedBookings.insertedIds[index]

      return {
        bookingId: bookingId.toString(),
        customerId: booking.customerId,
        ownerId: booking.ownerId,
        amount: booking.totalAmount,
        currency: "usd",
        status: "paid",
        method: "stripe",
        transactionId: `pi_demo_${String(index).padStart(3, "0")}`,
        demo: true,
        paidAt: new Date(new Date(booking.startDate).getTime() - 2 * day),
        createdAt: new Date(new Date(booking.startDate).getTime() - 2 * day),
      }
    })
    .filter(Boolean)

  if (paymentDocs.length > 0) {
    await db.collection("payments").insertMany(paymentDocs)
  }

  console.log(
    `Inserted ${equipmentDocs.length} equipment, ${bookingDocs.length} bookings and ${paymentDocs.length} payments.`
  )
} catch (error) {
  console.error("Seed failed:", error.message)
  process.exitCode = 1
} finally {
  await client.close()
}
