const { syncTimeEntryToCost, removeCost } = require("../services/monday/syncService");
const { requireBillingLock } = require("../middleware/billingLock");

const router = express.Router();

router.use(requireAuth);

router.get(
  "/",
  [
    query("date").optional().isISO8601().withMessage("date must be YYYY-MM-DD"),
    query("status").optional().isIn(["Open", "Complete", "Approved"]),
    query("technicianId").optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { date, status, technicianId } = req.query;

      // Determine whose entries to fetch
      let targetTechId = req.technician.id;
      if (technicianId) {
        if (!req.technician.isAdmin) {
          return res.status(403).json({ error: "Cannot view other technicians' entries" });
        }
        targetTechId = technicianId;
      }

      // Date range filter — default to today in CST
      const { dayStart, dayEnd } = getCSTDayBounds(date ?? undefined);

      const entries = await prisma.timeEntry.findMany({
        where: {
          technicianId: targetTechId,
          clockIn: { gte: dayStart, lte: dayEnd },
          ...(status ? { status } : {}),
        },
        include: {
          expenses: true,
          technician: { select: { id: true, name: true } },
        },
        orderBy: { clockIn: "asc" },
      });

      res.json({ data: entries });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/range",
  requireAdmin,
  [
    query("from").isISO8601().withMessage("from must be YYYY-MM-DD"),
    query("to").isISO8601().withMessage("to must be YYYY-MM-DD"),
    query("technicianId").optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { from, to, technicianId } = req.query;
      const { rangeStart, rangeEnd } = getCSTRangeBounds(from, to);

      const entries = await prisma.timeEntry.findMany({
        where: {
          clockIn: { gte: rangeStart, lte: rangeEnd },
          ...(technicianId ? { technicianId } : {}),
        },
        include: {
          expenses: true,
          technician: { select: { id: true, name: true } },
        },
        orderBy: [{ clockIn: "asc" }, { technicianId: "asc" }],
      });

      res.json({ data: entries });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:id",
  [param("id").isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const entry = await prisma.timeEntry.findUnique({
        where: { id: req.params.id },
        include: { expenses: true, technician: { select: { id: true, name: true } } },
      });

      if (!entry) return res.status(404).json({ error: "Entry not found" });

      if (!req.technician.isAdmin && entry.technicianId !== req.technician.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({ data: entry });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/clock-in",
  [
    body("entryType").isIn(["Job", "NonJob"]).withMessage("entryType must be Job or NonJob"),
    body("workOrderRef").if(body("entryType").equals("Job")).notEmpty().withMessage("workOrderRef is required for Job entries"),
    body("workOrderLabel").optional({ values: "null" }).isString(),
    body("taskCategory").optional({ values: "null" }).isString(),
    body("taskDescription").if(body("entryType").equals("NonJob")).notEmpty().withMessage("taskDescription is required for NonJob entries"),
  ],
  validate,
  requireBillingLock,
  async (req, res, next) => {
    try {
      const { entryType, workOrderRef, workOrderLabel, taskCategory, taskDescription } = req.body;

      // 1. Logic for Parallel Timers & Overlap
      // We allow one active timer per type (Job, NonJob, Travel)
      // BUT if starting a new Job while another is open, we auto-clockout the old one
      const openEntries = await prisma.timeEntry.findMany({
        where: { technicianId: req.technician.id, clockOut: null },
      });

      const sameTypeEntry = openEntries.find(e => e.entryType === entryType);

      if (sameTypeEntry) {
        if (entryType === "Job") {
          // Auto-clockout the previous job
          console.log(`[clock-in] Auto-clockout for previous Job ${sameTypeEntry.id} as new Job ${workOrderRef} is starting`);
          const now = new Date();
          const diffMs = now - sameTypeEntry.clockIn;
          const hours = parseFloat((diffMs / 3_600_000).toFixed(2));
          
          await prisma.timeEntry.update({
            where: { id: sameTypeEntry.id },
            data: { 
              clockOut: now, 
              hoursWorked: hours, 
              status: "Complete",
              narrative: `[Auto-Closed] Switched to new job ${workOrderLabel || workOrderRef}. Original session started at ${sameTypeEntry.clockIn.toISOString()}`,
              jobLocation: sameTypeEntry.jobLocation || "Not provided (Auto-closed)"
            }
          });

          // Also update Monday for the old entry
          if (sameTypeEntry.mondayItemId) {
            setImmediate(() => {
              monday.updateTimeEntryItem(sameTypeEntry.mondayItemId, { clockOut: now, hoursWorked: hours });
              syncTimeEntryToCost(sameTypeEntry.id).catch(console.error);
            });
          }
        } else {
          // For NonJob, just block if one is already open
          return res.status(409).json({
            error: `Already clocked in to a ${entryType} entry`,
            activeEntryId: sameTypeEntry.id,
          });
        }
      }

      await prisma.technician.upsert({
        where: { id: req.technician.id },
        update: { name: req.technician.name },
        create: { id: req.technician.id, name: req.technician.name, isAdmin: req.technician.isAdmin },
      });

      const clockIn = new Date();

      const entry = await prisma.timeEntry.create({
        data: {
          technicianId:    req.technician.id,
          entryType,
          workOrderRef:    workOrderRef    ?? null,
          workOrderLabel:  workOrderLabel  ?? null,
          taskCategory:    taskCategory    ?? null,
          taskDescription: taskDescription ?? null,
          clockIn,
          status: "Open",
        },
        include: { expenses: true },
      });

      // ── Monday.com side-effects (non-blocking — each operation is independent) ─
      setImmediate(async () => {
        // 1. For Job entries: update WO Execution Status to "In Progress" (highest priority)
        if (entryType === "Job" && workOrderRef) {
          try {
            await monday.setWorkOrderInProgress(workOrderRef);
          } catch (err) {
            console.error("[clock-in] Monday.com setWorkOrderInProgress error:", err.message);
          }
        }

        // 2. Create item on the Time Entries board
        try {
          const mondayItemId = await monday.createTimeEntryItem({
            technicianName: req.technician.name,
            mondayUserId:   req.technician.id,
            entryType,
            workOrderRef:    workOrderRef ?? null,
            workOrderLabel:  workOrderLabel ?? null,
            taskDescription: taskDescription ?? null,
            clockIn,
          });

          // Store the Monday.com item ID for later update on clock-out
          await prisma.timeEntry.update({
            where: { id: entry.id },
            data: { mondayItemId },
          });
        } catch (err) {
          console.error("[clock-in] Monday.com createTimeEntryItem error:", err.message);
        }
      });

      // ── Socket.io broadcast ────────────────────────────────────────────────
      emitTimeEvent("clock_in", {
        technicianId:  req.technician.id,
        technicianName: req.technician.name,
        entryId:       entry.id,
        entryType,
        workOrderRef:  workOrderRef ?? null,
        workOrderLabel: workOrderLabel ?? null,
        taskDescription: taskDescription ?? null,
        clockIn:       entry.clockIn,
      });

      res.status(201).json({ data: entry });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/:id/clock-out",
  [
    param("id").isString().notEmpty(),
    body("narrative").isLength({ min: 10 }).withMessage("narrative must be at least 10 characters"),
    body("jobLocation").notEmpty().withMessage("jobLocation is required"),
    body("expenses").optional().isArray(),
    body("expenses.*.type").optional().isIn(["Fuel", "Lodging", "Meals", "Supplies"]),
    body("expenses.*.amount").optional().isFloat({ min: 0 }),
    body("expenses.*.details").optional().isString(),
    body("markComplete").optional({ values: "null" }).isBoolean(),
  ],
  validate,
  requireBillingLock,
  async (req, res, next) => {
    try {
      const entry = await prisma.timeEntry.findUnique({ where: { id: req.params.id } });

      if (!entry) return res.status(404).json({ error: "Entry not found" });
      if (entry.technicianId !== req.technician.id && !req.technician.isAdmin) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (entry.clockOut) {
        return res.status(409).json({ error: "Entry is already clocked out" });
      }

      const clockOut = new Date();
      const diffMs = clockOut - entry.clockIn;
      const hoursWorked = parseFloat((diffMs / 3_600_000).toFixed(2));

      const { narrative, jobLocation, expenses = [], markComplete = false } = req.body;

      const updated = await prisma.$transaction(async (tx) => {
        const updatedEntry = await tx.timeEntry.update({
          where: { id: entry.id },
          data: {
            clockOut,
            hoursWorked,
            status: "Complete",
            narrative,
            jobLocation,
          },
        });

        if (expenses.length > 0) {
          const { syncExpenseToCost } = require("../services/monday/syncService");
          
          for (const e of expenses) {
            const expense = await tx.expense.create({
              data: {
                timeEntryId: entry.id,
                type:    e.type,
                amount:  e.amount,
                details: e.details ?? null,
              }
            });
            // Cost sync will happen in setImmediate after this transaction
          }
        }

        return tx.timeEntry.findUnique({
          where: { id: entry.id },
          include: { expenses: true },
        });
      });

      // ── Monday.com side-effects (non-blocking) ──────────────────────────────
      setImmediate(async () => {
        try {
          const hasExpenses = expenses.length > 0;

          // 1. Update the Time Entry item on Monday.com
          if (entry.mondayItemId) {
            await monday.updateTimeEntryItem(entry.mondayItemId, {
              clockOut,
              hoursWorked,
              hasExpenses,
              narrative,
              jobLocation,
              workOrderRef: entry.workOrderRef,
            });
          }

          // 2. If technician marked the job complete, or if we need to update status
          if (entry.entryType === "Job" && entry.workOrderRef) {
            try {
              if (markComplete) {
                await monday.setWorkOrderComplete(entry.workOrderRef);
              }
            } catch (err) {
              console.error("[clock-out] Monday.com set status error:", err.message);
            }
          }

          // 3. Sync Time Entry to Master Cost Board (Labor)
          try {
            await syncTimeEntryToCost(entry.id);
          } catch (err) {
            console.error("[clock-out] syncTimeEntryToCost error:", err.message);
          }

          // 4. Create and Sync Expenses to Monday (Expenses Board & Master Costs)
          // Refetch to get IDs for expense sync
          const fullEntry = await prisma.timeEntry.findUnique({
            where: { id: entry.id },
            include: { expenses: true }
          });

          for (const exp of fullEntry.expenses) {
            try {
              // 4a. Sync to Expenses board
              const expenseMondayId = await monday.createExpenseItem({
                mondayUserId:      req.technician.id,
                type:              exp.type,
                amount:            exp.amount,
                details:           exp.details ?? "",
                workOrderId:       entry.workOrderRef || null,
                timeEntryMondayId: entry.mondayItemId || null,
                expenseItemName:   `${exp.type} — ${req.technician.name}`,
              });

              // 4b. Trigger Master Cost Sync for this expense
              const { syncExpenseToCost } = require("../services/monday/syncService");
              await syncExpenseToCost(exp.id);
              
              console.log(`[clock-out] ✓ Expense (${exp.type}) synced for WO ${entry.workOrderRef}`);
            } catch (err) {
              console.error(`[clock-out] Monday.com expense sync error (${exp.type}):`, err.message);
            }
          }
        } catch (mondayErr) {
          console.error("[clock-out] Monday.com general sync error:", mondayErr.message);
        }

      });

      emitTimeEvent("clock_out", {
        technicianId:   req.technician.id,
        technicianName: req.technician.name,
        entryId:        updated.id,
        entryType:      updated.entryType,
        workOrderLabel: updated.workOrderLabel ?? null,
        taskDescription: updated.taskDescription ?? null,
        clockIn:        updated.clockIn,
        clockOut:       updated.clockOut,
        hoursWorked:    updated.hoursWorked,
        status:         updated.status,
      });

      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/:id/status",
  requireAdmin,
  [
    param("id").isString().notEmpty(),
    body("status").isIn(["Open", "Complete", "Approved"]),
  ],
  validate,
  async (req, res, next) => {
    try {
      const entry = await prisma.timeEntry.update({
        where: { id: req.params.id },
        data: { status: req.body.status },
      });
      res.json({ data: entry });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/:id",
  requireAdmin,
  [param("id").isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const entry = await prisma.timeEntry.findUnique({ where: { id: req.params.id } });
      if (entry?.masterCostItemId) {
        removeCost(entry.masterCostItemId).catch(console.error);
      }
      await prisma.timeEntry.delete({ where: { id: req.params.id } });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
