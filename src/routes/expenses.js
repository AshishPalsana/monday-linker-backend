const express = require("express");
const { body, param } = require("express-validator");
const prisma = require("../lib/prisma");
const monday = require("../lib/mondayClient");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { syncExpenseToCost, removeCost } = require("../services/monday/syncService");
const { requireBillingLock } = require("../middleware/billingLock");

const router = express.Router();
router.use(requireAuth);

router.get(
  "/:id",
  [param("id").isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const expense = await prisma.expense.findUnique({
        where: { id: req.params.id },
        include: { timeEntry: { select: { technicianId: true } } },
      });

      if (!expense) return res.status(404).json({ error: "Expense not found" });

      if (
        !req.technician.isAdmin &&
        expense.timeEntry.technicianId !== req.technician.id
      ) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({ data: expense });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/",
  [
    body("timeEntryId").isString().notEmpty(),
    body("type")
      .isIn(["Fuel", "Lodging", "Meals", "Supplies"])
      .withMessage("type must be Fuel, Lodging, Meals, or Supplies"),
    body("amount")
      .isFloat({ min: 0 })
      .withMessage("amount must be a positive number"),
    body("details").optional().isString(),
    body("receiptUrl")
      .optional()
      .isURL()
      .withMessage("receiptUrl must be a valid URL"),
  ],
  validate,
  requireBillingLock,
  async (req, res, next) => {
    try {
      const { timeEntryId, type, amount, details, receiptUrl } = req.body;

      const entry = await prisma.timeEntry.findUnique({
        where: { id: timeEntryId },
      });
      if (!entry)
        return res.status(404).json({ error: "Time entry not found" });

      if (!req.technician.isAdmin && entry.technicianId !== req.technician.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      const expense = await prisma.expense.create({
        data: {
          timeEntryId,
          type,
          amount,
          details: details ?? null,
          receiptUrl: receiptUrl ?? null,
        },
      });

      setImmediate(async () => {
        try {
          await monday.createExpenseItem({
            mondayUserId: req.technician.id,
            type,
            amount: parseFloat(amount),
            details: details ?? "",
            workOrderId: entry.workOrderRef || null,
            timeEntryMondayId: entry.mondayItemId || null,
            expenseItemName: `${type} — ${req.technician.name}`,
          });

          await syncExpenseToCost(expense.id);
        } catch (mondayErr) {
          console.error(
            "[expenses POST] Monday.com sync error:",
            mondayErr.message,
          );
        }
      });

      res.status(201).json({ data: expense });
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/:id",
  [
    param("id").isString().notEmpty(),
    body("amount").optional().isFloat({ min: 0 }),
    body("details").optional().isString(),
    body("receiptUrl").optional().isURL(),
  ],
  validate,
  requireBillingLock,
  async (req, res, next) => {
    try {
      const existing = await prisma.expense.findUnique({
        where: { id: req.params.id },
        include: { timeEntry: { select: { technicianId: true } } },
      });

      if (!existing)
        return res.status(404).json({ error: "Expense not found" });
      if (
        !req.technician.isAdmin &&
        existing.timeEntry.technicianId !== req.technician.id
      ) {
        return res.status(403).json({ error: "Access denied" });
      }

      const { amount, details, receiptUrl } = req.body;
      const updated = await prisma.expense.update({
        where: { id: req.params.id },
        data: {
          ...(amount !== undefined ? { amount } : {}),
          ...(details !== undefined ? { details } : {}),
          ...(receiptUrl !== undefined ? { receiptUrl } : {}),
        },
      });

      setImmediate(() => {
        syncExpenseToCost(updated.id).catch(console.error);
      });

      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/:id",
  requireAdmin,
  [param("id").isString().notEmpty()],
  validate,
  requireBillingLock,
  async (req, res, next) => {
    try {
      const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
      if (existing?.masterCostItemId) {
        removeCost(existing.masterCostItemId).catch(console.error);
      }
      await prisma.expense.delete({ where: { id: req.params.id } });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
