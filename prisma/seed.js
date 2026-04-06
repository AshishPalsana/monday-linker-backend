// Seed script — creates a few test technicians and sample entries
// Run: npm run db:seed

const { PrismaClient, EntryType, EntryStatus, ExpenseType } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Technicians
  const edgar = await prisma.technician.upsert({
    where: { id: "monday_user_001" },
    update: {},
    create: {
      id: "monday_user_001",
      name: "Edgar Pendley",
      email: "edgar@aaroneq.com",
      isAdmin: false,
    },
  });

  const admin = await prisma.technician.upsert({
    where: { id: "monday_user_admin" },
    update: {},
    create: {
      id: "monday_user_admin",
      name: "Admin User",
      email: "admin@aaroneq.com",
      isAdmin: true,
    },
  });

  console.log(`Created technicians: ${edgar.name}, ${admin.name}`);

  // Sample completed time entry for Edgar
  const today = new Date();
  const clockInTime = new Date(today);
  clockInTime.setHours(7, 48, 0, 0);
  const clockOutTime = new Date(today);
  clockOutTime.setHours(11, 30, 0, 0);

  const entry = await prisma.timeEntry.create({
    data: {
      technicianId: edgar.id,
      entryType: EntryType.Job,
      status: EntryStatus.Complete,
      workOrderRef: "11429209991",
      workOrderLabel: "WO-1354 · Ice Machine Repair",
      clockIn: clockInTime,
      clockOut: clockOutTime,
      hoursWorked: 3.7,
      narrative: "Replaced compressor relay and tested unit.",
      jobLocation: "Store #42 - Dallas",
    },
  });

  console.log(`Created sample entry: ${entry.id}`);

  // Sample Non-Job entry
  const clockIn2 = new Date(today);
  clockIn2.setHours(12, 0, 0, 0);
  const clockOut2 = new Date(today);
  clockOut2.setHours(12, 45, 0, 0);

  await prisma.timeEntry.create({
    data: {
      technicianId: edgar.id,
      entryType: EntryType.NonJob,
      status: EntryStatus.Complete,
      taskCategory: "Safety Meeting",
      taskDescription: "Monthly safety briefing",
      clockIn: clockIn2,
      clockOut: clockOut2,
      hoursWorked: 0.75,
      narrative: "Attended monthly safety meeting.",
      jobLocation: "Shop",
    },
  });

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
