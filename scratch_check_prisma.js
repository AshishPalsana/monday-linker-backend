const prisma = require("./src/lib/prisma");
console.log("Prisma keys:", Object.keys(prisma).filter(k => !k.startsWith("_")));
process.exit(0);
