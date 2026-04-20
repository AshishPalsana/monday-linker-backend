const prisma = require("./src/lib/prisma");

async function migrate() {
  console.log("Starting data migration: General -> DailyShift...");
  
  const result = await prisma.timeEntry.updateMany({
    where: { entryType: "General" },
    data: { entryType: "DailyShift" }
  });

  console.log(`Successfully updated ${result.count} entries.`);
}

migrate()
  .catch(err => {
    console.error("Migration failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
