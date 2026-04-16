const express = require("express");
const { body, param, query } = require("express-validator");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const monday = require("../lib/mondayClient");

const router = express.Router();
router.use(requireAuth);

// ─── GET /api/master-costs?workOrderId=<mondayItemId> ─────────────────────────
// Returns all cost items linked to a Work Order from the Master Costs board.
router.get(
  "/",
  [query("workOrderId").optional().isString()],
  validate,
  async (req, res, next) => {
    try {
      const { workOrderId } = req.query;
      const items = await monday.getMasterCosts(workOrderId || null);
      res.json({ data: items });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/master-costs ────────────────────────────────────────────────────
// Creates a new cost line item on the Master Costs board.
// Body: { workOrderId, workOrderLabel, type, quantity, rate, description, date }
router.post(
  "/",
  [
    body("workOrderId").isString().notEmpty().withMessage("workOrderId required"),
    body("type")
      .isIn(["Labor", "Parts", "Expense"])
      .withMessage("type must be Labor, Parts, or Expense"),
    body("quantity").isFloat({ min: 0 }).withMessage("quantity must be >= 0"),
    body("rate").isFloat({ min: 0 }).withMessage("rate must be >= 0"),
    body("description").optional().isString(),
    body("date").optional().isString(),
    body("workOrderLabel").optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { workOrderId, workOrderLabel, type, quantity, rate, description, date } = req.body;

      const totalCost = parseFloat((quantity * rate).toFixed(2));

      const created = await monday.createMasterCostItem({
        workOrderId,
        workOrderLabel: workOrderLabel || "",
        type,
        quantity: parseFloat(quantity),
        rate: parseFloat(rate),
        totalCost,
        description: description || "",
        date: date || null,
        mondayUserId: req.technician.mondayUserId || null,
      });

      res.status(201).json({ data: created });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PATCH /api/master-costs/:mondayItemId ────────────────────────────────────
// Updates a cost item's quantity, rate, description, or type.
router.patch(
  "/:mondayItemId",
  [
    param("mondayItemId").isString().notEmpty(),
    body("type").optional().isIn(["Labor", "Parts", "Expense"]),
    body("quantity").optional().isFloat({ min: 0 }),
    body("rate").optional().isFloat({ min: 0 }),
    body("description").optional().isString(),
    body("date").optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { mondayItemId } = req.params;
      const { type, quantity, rate, description, date } = req.body;

      const updates = {};
      if (type        !== undefined) updates.type        = type;
      if (description !== undefined) updates.description = description;
      if (date        !== undefined) updates.date        = date;
      if (quantity    !== undefined) updates.quantity    = parseFloat(quantity);
      if (rate        !== undefined) updates.rate        = parseFloat(rate);
      // Recalculate total if qty or rate changed
      if (quantity !== undefined || rate !== undefined) {
        const q = quantity !== undefined ? parseFloat(quantity) : null;
        const r = rate     !== undefined ? parseFloat(rate)     : null;
        if (q !== null && r !== null) updates.totalCost = parseFloat((q * r).toFixed(2));
      }

      await monday.updateMasterCostItem(mondayItemId, updates);
      res.json({ data: { mondayItemId, ...updates } });
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE /api/master-costs/:mondayItemId ──────────────────────────────────
// Deletes a cost item from Monday (admin only).
router.delete(
  "/:mondayItemId",
  requireAdmin,
  [param("mondayItemId").isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      await monday.deleteMasterCostItem(req.params.mondayItemId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
