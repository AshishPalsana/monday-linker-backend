const prisma = require("./src/lib/prisma");

async function check() {
  console.log("Prisma instance models:", Object.keys(prisma).filter(k => !k.startsWith("_")));
  try {
    const woCount = await prisma.workOrder.count();
    console.log("WorkOrder count:", woCount);
    const syncCount = await prisma.workOrderSync.count();
    console.log("WorkOrderSync count:", syncCount);
    const customerCount = await prisma.customer.count();
    console.log("Customer count:", customerCount);
    console.log("✅ Prisma Client all models verified.");
  } catch (err) {
    console.error("❌ Prisma check failed:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

check();
