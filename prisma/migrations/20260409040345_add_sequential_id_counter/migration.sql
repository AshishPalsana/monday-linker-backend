-- CreateTable
CREATE TABLE "sequential_id_counters" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "currentId" INTEGER NOT NULL DEFAULT 1000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequential_id_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sequential_id_counters_boardId_key" ON "sequential_id_counters"("boardId");
