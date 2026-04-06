const express = require("express");
const { body, param } = require("express-validator");
const prisma = require("../lib/prisma");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/validate");

const router = express.Router();
router.use(requireAuth);

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const technicians = await prisma.technician.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, isAdmin: true, createdAt: true },
    });
    res.json({ data: technicians });
  } catch (err) {
    next(err);
  }
});

router.get("/me", async (req, res, next) => {
  try {
    const tech = await prisma.technician.findUnique({
      where: { id: req.technician.id },
      select: { id: true, name: true, email: true, isAdmin: true },
    });
    res.json({
      data: tech ?? {
        id:      req.technician.id,
        name:    req.technician.name,
        isAdmin: req.technician.isAdmin,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/:id",
  [param("id").isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      if (!req.technician.isAdmin && req.params.id !== req.technician.id) {
        return res.status(403).json({ error: "Access denied" });
      }
      const tech = await prisma.technician.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true, email: true, isAdmin: true, createdAt: true },
      });
      if (!tech) return res.status(404).json({ error: "Technician not found" });
      res.json({ data: tech });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/:id",
  requireAdmin,
  [
    param("id").isString().notEmpty(),
    body("name").optional().isString().notEmpty(),
    body("email").optional().isEmail(),
    body("isAdmin").optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name, email, isAdmin } = req.body;
      const updated = await prisma.technician.update({
        where: { id: req.params.id },
        data: {
          ...(name    !== undefined ? { name }    : {}),
          ...(email   !== undefined ? { email }   : {}),
          ...(isAdmin !== undefined ? { isAdmin } : {}),
        },
      });
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
