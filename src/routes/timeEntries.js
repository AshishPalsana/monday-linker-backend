const express = require("express");
const { body, query, param } = require("express-validator");
const prisma = require("../lib/prisma");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const monday = require("../lib/mondayClient");
const { emitTimeEvent } = require("../lib/socketServer");
const { getCSTDayBounds, getCSTRangeBounds } = require("../lib/cstTime");

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
  async (req, res, next) => {
    try {
      const openEntry = await prisma.timeEntry.findFirst({
        where: { technicianId: req.technician.id, clockOut: null },
      });

      if (openEntry) {
        return res.status(409).json({
          error: "Already clocked in",
          activeEntryId: openEntry.id,
        });
      }

      await prisma.technician.upsert({
        where: { id: req.technician.id },
        update: { name: req.technician.name },
        create: { id: req.technician.id, name: req.technician.name, isAdmin: req.technician.isAdmin },
      });

      const { entryType, workOrderRef, workOrderLabel, taskCategory, taskDescription } = req.body;
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
          await tx.expense.createMany({
            data: expenses.map((e) => ({
              timeEntryId: entry.id,
              type:    e.type,
              amount:  e.amount,
              details: e.details ?? null,
            })),
          });
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
            });
          }

          // 2. If technician marked the job complete, or if we need to update status
          if (entry.entryType === "Job" && entry.workOrderRef) {
            try {
              if (markComplete) {
                await monday.setWorkOrderComplete(entry.workOrderRef);
              } else {
                // Keep "In Progress" or other status logic if needed
                // For now, if they clock out WITHOUT marking complete, we might leave it in progress
              }
            } catch (err) {
              console.error("[clock-out] Monday.com set status error:", err.message);
            }
            
            // 2b. Automatically record hours as an "expense" on the Monday.com Expenses board
            try {
              await monday.createExpenseItem({
                mondayUserId:  req.technician.id,
                type:          "Supplies", // Using Supplies as placeholder for Labor until Labor type is added
                amount:        hoursWorked, // recording hours as "amount" for now, needs charge-back logic
                details:       `Labor Hours: ${hoursWorked}h | Narrative: ${narrative.slice(0, 100)}...`,
                workOrderLabel: entry.workOrderLabel || entry.workOrderRef || "",
                expenseItemName: `Labor — ${req.technician.name}`,
              });
            } catch (err) {
              console.error("[clock-out] Monday.com labor expense sync error:", err.message);
            }
          }

          // 3. Create Expense items on Monday.com Expenses board
          for (const exp of expenses) {
            await monday.createExpenseItem({
              mondayUserId:  req.technician.id,
              type:          exp.type,
              amount:        exp.amount,
              details:       exp.details ?? "",
              workOrderLabel: entry.workOrderLabel || entry.workOrderRef || "",
              expenseItemName: `${exp.type} — ${req.technician.name}`,
            });
          }
        } catch (mondayErr) {
          console.error("[clock-out] Monday.com sync error:", mondayErr.message);
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
      await prisma.timeEntry.delete({ where: { id: req.params.id } });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
