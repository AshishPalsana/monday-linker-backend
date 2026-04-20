-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "masterCostItemId" TEXT;

-- AlterTable
ALTER TABLE "technicians" ADD COLUMN     "billingRate" DECIMAL(10,2) NOT NULL DEFAULT 85.00,
ADD COLUMN     "burdenRate" DECIMAL(10,2) NOT NULL DEFAULT 0.00;

-- AlterTable
ALTER TABLE "time_entries" ADD COLUMN     "masterCostItemId" TEXT;

-- CreateTable
CREATE TABLE "work_orders" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT,
    "billingStage" TEXT,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "accountNumber" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "country" TEXT,
    "billingAddress" TEXT,
    "billingTerms" TEXT,
    "xeroContactId" TEXT,
    "xeroSyncStatus" TEXT NOT NULL DEFAULT 'Pending',
    "syncErrorMessage" TEXT,
    "syncErrorCode" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "syncVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_syncs" (
    "id" TEXT NOT NULL,
    "mondayItemId" TEXT NOT NULL,
    "companyCamProjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "partsMarkup" DECIMAL(4,2) NOT NULL DEFAULT 1.35,
    "expenseMarkup" DECIMAL(4,2) NOT NULL DEFAULT 1.10,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "global_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "location_syncs_mondayItemId_key" ON "location_syncs"("mondayItemId");

-- CreateIndex
CREATE UNIQUE INDEX "location_syncs_companyCamProjectId_key" ON "location_syncs"("companyCamProjectId");

-- AddForeignKey
ALTER TABLE "work_order_syncs" ADD CONSTRAINT "work_order_syncs_mondayItemId_fkey" FOREIGN KEY ("mondayItemId") REFERENCES "work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
