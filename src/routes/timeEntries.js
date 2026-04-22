const express = require("express");
const { body, param, query } = require("express-validator");
const prisma = require("../lib/prisma");
const monday = require("../lib/mondayClient");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { emitTimeEvent } = require("../lib/socketServer");
const { getCSTDayBounds, getCSTRangeBounds } = require("../lib/cstTime");
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

      let targetTechId = req.technician.id;
      if (technicianId) {
        if (!req.technician.isAdmin) {
          return res.status(403).json({ error: "Cannot view other technicians' entries" });
        }
        targetTechId = technicianId;
      }

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
    body("entryType").isIn(["Job", "NonJob", "DailyShift"]).withMessage("entryType must be Job, NonJob, or DailyShift"),
    body("workOrderRef").if(body("entryType").equals("Job")).notEmpty().withMessage("workOrderRef is required for Job entries"),
    body("workOrderLabel").optional({ values: "null" }).isString(),
    body("taskCategory").optional({ values: "null" }).isString(),
    body("taskDescription").if(body("entryType").isIn(["NonJob", "DailyShift"])).notEmpty().withMessage("taskDescription is required for NonJob or DailyShift entries"),
  ],
  validate,
  requireBillingLock,
  async (req, res, next) => {
    try {
      const { entryType, workOrderRef, workOrderLabel, taskCategory, taskDescription } = req.body;

      // ── Assignment-Based Validation ────────────────────────
      if (entryType === "Job" && workOrderRef) {
        let isAssigned = false;
        
        // 1. Check local cache
        const localWO = await prisma.workOrder.findUnique({
          where: { id: String(workOrderRef) }
        });
        
        isAssigned = localWO?.assignedTechnicianIds.includes(String(req.technician.id));
        
        // 2. Self-healing fallback: If not assigned in local cache, verify with Monday directly
        if (!isAssigned) {
          console.log(`[clock-in] Cache miss/denied for WO ${workOrderRef}, tech ${req.technician.id}. Verifying with Monday…`);
          const latestTechIds = await monday.getWorkOrderAssignedTechnicians(workOrderRef);
          
          // Atomically update local cache (idempotent upsert)
          await prisma.workOrder.upsert({
            where: { id: String(workOrderRef) },
            update: { assignedTechnicianIds: latestTechIds },
            create: { id: String(workOrderRef), assignedTechnicianIds: latestTechIds }
          });
          
          isAssigned = latestTechIds.includes(String(req.technician.id));
        }
        
        if (!isAssigned) {
          console.warn(`[clock-in] Forbidden: Technician ${req.technician.id} not assigned to WO ${workOrderRef}`);
          return res.status(403).json({ error: "You are not assigned to this work order" });
        }
      }

      const openEntries = await prisma.timeEntry.findMany({
        where: { technicianId: req.technician.id, clockOut: null },
      });

      const activeShift = openEntries.find(e => e.entryType === "DailyShift");
      const activeTask = openEntries.find(e => e.entryType === "Job" || e.entryType === "NonJob");

      // Requirement 1: Must have active DailyShift for any Task
      if (entryType !== "DailyShift" && !activeShift) {
        return res.status(403).json({ 
          error: "You must clock in for the day (Daily Shift) before starting a task" 
        });
      }

      // Requirement 2: Cannot have multiple DailyShifts
      if (entryType === "DailyShift" && activeShift) {
        return res.status(409).json({
          error: "Already clocked in for the day",
          activeEntryId: activeShift.id
        });
      }

      // Requirement 3: Only one active task at a time. Auto-close previous if new one starts.
      if ((entryType === "Job" || entryType === "NonJob") && activeTask) {
        console.log(`[clock-in] Auto-clockout for previous ${activeTask.entryType} ${activeTask.id} as new ${entryType} is starting`);
        
        const now = new Date();
        const diffMs = now - activeTask.clockIn;
        const hours = parseFloat((diffMs / 3_600_000).toFixed(2));

        await prisma.timeEntry.update({
          where: { id: activeTask.id },
          data: {
            clockOut: now,
            hoursWorked: hours,
            status: "Complete",
            narrative: `[Auto-Closed] Switched to new ${entryType === "Job" ? "job" : "task"} ${workOrderLabel || taskDescription || "session"}. Original started at ${activeTask.clockIn.toISOString()}`,
            jobLocation: activeTask.jobLocation || "Not provided (Auto-closed)"
          }
        });

        if (activeTask.mondayItemId) {
          setImmediate(() => {
            monday.updateTimeEntryItem(activeTask.mondayItemId, { clockOut: now, hoursWorked: hours });
            syncTimeEntryToCost(activeTask.id).catch(console.error);
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
          technicianId: req.technician.id,
          entryType,
          workOrderRef: workOrderRef ?? null,
          workOrderLabel: workOrderLabel ?? null,
          taskCategory: taskCategory ?? null,
          taskDescription: taskDescription ?? null,
          clockIn,
          status: "Open",
        },
        include: { expenses: true },
      });

      setImmediate(async () => {
        if (entryType === "Job" && workOrderRef) {
          try {
            await monday.setWorkOrderInProgress(workOrderRef);
          } catch (err) {
            console.error("[clock-in] Monday.com setWorkOrderInProgress error:", err.message);
          }
        }

        try {
          const mondayItemId = await monday.createTimeEntryItem({
            technicianName: req.technician.name,
            mondayUserId: req.technician.id,
            entryType,
            workOrderRef: workOrderRef ?? null,
            workOrderLabel: workOrderLabel ?? null,
            taskDescription: taskDescription ?? null,
            clockIn,
          });

          await prisma.timeEntry.update({
            where: { id: entry.id },
            data: { mondayItemId },
          });
        } catch (err) {
          console.error("[clock-in] Monday.com createTimeEntryItem error:", err.message);
        }
      });

      emitTimeEvent("clock_in", {
        technicianId: req.technician.id,
        technicianName: req.technician.name,
        entryId: entry.id,
        entryType,
        workOrderRef: workOrderRef ?? null,
        workOrderLabel: workOrderLabel ?? null,
        taskDescription: taskDescription ?? null,
        clockIn: entry.clockIn,
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
    body("narrative").optional({ values: "null" }).isString(),
    body("jobLocation").optional({ values: "null" }).isString(),
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

      const isDailyShift = entry.entryType === "DailyShift";

      // Narrative and location are required for Job and NonJob, not DailyShift
      if (!isDailyShift) {
        const { narrative: nar, jobLocation: loc } = req.body;
        if (!nar || nar.trim().length < 10) {
          return res.status(400).json({ error: "narrative must be at least 10 characters" });
        }
        if (!loc || !loc.trim()) {
          return res.status(400).json({ error: "jobLocation is required" });
        }
      }

      const clockOut = new Date();
      const diffMs = clockOut - entry.clockIn;
      const hoursWorked = parseFloat((diffMs / 3_600_000).toFixed(2));

      // Live check of Monday "Expenses Added" status — only relevant for Job/NonJob
      if (!isDailyShift && entry.mondayItemId) {
        const item = await monday.getTimeEntryDetails(entry.mondayItemId);
        const expAddedCol = item?.column_values?.find(c => c.id === monday.COL.TIME_ENTRIES.EXPENSES_ADDED);
        const isExpMarked = expAddedCol?.text === "v" || expAddedCol?.value === "{\"checked\":\"true\"}";

        if (isExpMarked && (!req.body.expenses || req.body.expenses.length === 0)) {
           const dbExps = await prisma.expense.count({ where: { timeEntryId: entry.id } });
           if (dbExps === 0) {
             return res.status(400).json({
               error: "Expenses details are required. You marked that expenses were added during the day, so you must provide details before clocking out.",
               code: "EXPENSES_DETAILS_REQUIRED"
             });
           }
        }
      }

      const { narrative = "", jobLocation = "", jobLocationId = null, expenses = [], markComplete = false } = req.body;

      const existingExpenses = await prisma.expense.findMany({
        where: { timeEntryId: entry.id }
      });

      const allExpenses = [...existingExpenses, ...expenses];

      const incomplete = allExpenses.find(e => !e.type || !e.amount || parseFloat(e.amount) <= 0);

      if (incomplete) {
        return res.status(400).json({
          error: `Incomplete expense detected (${incomplete.type || "Unknown"}). Please ensure all expenses have a valid amount before clocking out.`,
          code: "INCOMPLETE_EXPENSE"
        });
      }

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

        // Hierarchy Enforcement: If ending a DailyShift, auto-close any open tasks
        if (entry.entryType === "DailyShift") {
          const openTask = await tx.timeEntry.findFirst({
            where: {
              technicianId: req.technician.id,
              clockOut: null,
              entryType: { in: ["Job", "NonJob"] }
            }
          });

          if (openTask) {
            console.log(`[clock-out] Auto-closing task ${openTask.id} because DailyShift ${entry.id} is ending`);
            const taskDiffMs = clockOut - openTask.clockIn;
            const taskHours = parseFloat((taskDiffMs / 3_600_000).toFixed(2));

            await tx.timeEntry.update({
              where: { id: openTask.id },
              data: {
                clockOut: clockOut,
                hoursWorked: taskHours,
                status: "Complete",
                narrative: `[Auto-Closed] Daily Shift ended at ${clockOut.toISOString()}`,
                jobLocation: jobLocation || "Not provided (Auto-closed)"
              }
            });

            // Note: Monday sync for the auto-closed task is handled in the setImmediate block below
          }
        }

        if (expenses.length > 0) {
          for (const e of expenses) {
            await tx.expense.create({
              data: {
                timeEntryId: entry.id,
                type: e.type,
                amount: e.amount,
                details: e.details ?? e.description ?? null,
              }
            });
          }
        }

        return tx.timeEntry.findUnique({
          where: { id: entry.id },
          include: { expenses: true },
        });
      });

      setImmediate(async () => {
        try {
          const hasExpenses = expenses.length > 0;

          // 1. Sync the primary entry being clocked out
          if (entry.mondayItemId) {
            await monday.updateTimeEntryItem(entry.mondayItemId, {
              clockOut,
              hoursWorked,
              hasExpenses,
              narrative,
              jobLocation,
              jobLocationId,
              workOrderRef: entry.workOrderRef,
            });
          }

          // 2. Handle auto-closed tasks if this was a DailyShift ending
          if (entry.entryType === "DailyShift") {
            const closedTask = await prisma.timeEntry.findFirst({
              where: {
                technicianId: req.technician.id,
                clockOut: clockOut,
                status: "Complete",
                narrative: { startsWith: "[Auto-Closed]" }
              },
              orderBy: { updatedAt: "desc" }
            });

            if (closedTask?.mondayItemId) {
              console.log(`[clock-out] Syncing auto-closed task ${closedTask.id} to Monday...`);
              await monday.updateTimeEntryItem(closedTask.mondayItemId, {
                clockOut: clockOut,
                hoursWorked: closedTask.hoursWorked,
                narrative: closedTask.narrative,
                jobLocation: closedTask.jobLocation,
                workOrderRef: closedTask.workOrderRef
              });
              await syncTimeEntryToCost(closedTask.id).catch(console.error);
            }
          }

          if (entry.entryType === "Job" && entry.workOrderRef) {
            try {
              if (markComplete) {
                await monday.setWorkOrderComplete(entry.workOrderRef);
              }
            } catch (err) {
              console.error("[clock-out] Monday.com set status error:", err.message);
            }
          }

          try {
            await syncTimeEntryToCost(entry.id);
          } catch (err) {
            console.error("[clock-out] syncTimeEntryToCost error:", err.message);
          }

          const fullEntry = await prisma.timeEntry.findUnique({
            where: { id: entry.id },
            include: { expenses: true }
          });

          for (const exp of fullEntry.expenses) {
            try {
              const expenseMondayId = await monday.createExpenseItem({
                mondayUserId: req.technician.id,
                type: exp.type,
                amount: exp.amount,
                details: exp.details ?? "",
                workOrderId: entry.workOrderRef || null,
                timeEntryMondayId: entry.mondayItemId || null,
                expenseItemName: `${exp.type} — ${req.technician.name}`,
              });

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
        technicianId: req.technician.id,
        technicianName: req.technician.name,
        entryId: updated.id,
        entryType: updated.entryType,
        workOrderLabel: updated.workOrderLabel ?? null,
        taskDescription: updated.taskDescription ?? null,
        clockIn: updated.clockIn,
        clockOut: updated.clockOut,
        hoursWorked: updated.hoursWorked,
        status: updated.status,
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
