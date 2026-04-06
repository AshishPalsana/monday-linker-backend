-- CreateEnum
CREATE TYPE "EntryType" AS ENUM ('Job', 'NonJob');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('Open', 'Complete', 'Approved');

-- CreateEnum
CREATE TYPE "ExpenseType" AS ENUM ('Fuel', 'Lodging', 'Meals', 'Supplies');

-- CreateTable
CREATE TABLE "technicians" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "technicians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_entries" (
    "id" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "entryType" "EntryType" NOT NULL,
    "status" "EntryStatus" NOT NULL DEFAULT 'Open',
    "workOrderRef" TEXT,
    "workOrderLabel" TEXT,
    "taskCategory" TEXT,
    "taskDescription" TEXT,
    "mondayItemId" TEXT,
    "clockIn" TIMESTAMP(3) NOT NULL,
    "clockOut" TIMESTAMP(3),
    "hoursWorked" DECIMAL(6,2),
    "narrative" TEXT,
    "jobLocation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "timeEntryId" TEXT NOT NULL,
    "type" "ExpenseType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "details" TEXT,
    "receiptUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "technicians_email_key" ON "technicians"("email");

-- CreateIndex
CREATE INDEX "time_entries_technicianId_clockIn_idx" ON "time_entries"("technicianId", "clockIn");

-- CreateIndex
CREATE INDEX "time_entries_workOrderRef_idx" ON "time_entries"("workOrderRef");

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "time_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
