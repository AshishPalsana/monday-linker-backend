const express = require("express");
const { body, param } = require("express-validator");
const prisma = require("../lib/prisma");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const monday = require("../lib/mondayClient");

const router = express.Router();
router.use(requireAuth);

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const technicians = await prisma.technician.findMany({
      where: { isAdmin: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, isAdmin: true, burdenRate: true, createdAt: true },
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
        select: { id: true, name: true, email: true, isAdmin: true, burdenRate: true, createdAt: true },
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

// ── POST /api/technicians/sync-from-monday ────────────────────────────────────
// Fetches all non-admin Monday workspace users and creates a Technicians board
// row for any who don't already have one. Matched by email (case-insensitive).
router.post("/sync-from-monday", requireAdmin, async (req, res, next) => {
  try {
    // 1. Fetch all non-admin Monday users and existing Technicians board rows in parallel
    const [mondayUsers, existingItems] = await Promise.all([
      monday.getAllMondayUsers(),
      monday.getAllTechnicianBoardItems(),
    ]);

    const nonAdmins = mondayUsers.filter((u) => !u.is_admin && u.email);
    const existingEmails = new Set(existingItems.map((t) => t.email));

    const results = { created: 0, skipped: 0, errors: [] };

    // 2. Create board row for each user not already on the Technicians board
    for (const user of nonAdmins) {
      const email = user.email.toLowerCase().trim();
      if (existingEmails.has(email)) {
        results.skipped++;
        continue;
      }

      try {
        await monday.createTechnicianBoardItem({ name: user.name, email: user.email });
        existingEmails.add(email);
        results.created++;
        console.log(`[technicians/sync] ✓ Created board row for "${user.name}" (${user.email})`);
      } catch (err) {
        console.error(`[technicians/sync] ✗ Failed for "${user.name}":`, err.message);
        results.errors.push({ name: user.name, email: user.email, error: err.message });
      }

      // Always upsert into DB so the page shows all synced technicians
      // even before they log in for the first time
      await prisma.technician.upsert({
        where: { id: String(user.id) },
        update: { name: user.name, ...(user.email ? { email: user.email } : {}) },
        create: { id: String(user.id), name: user.name, email: user.email || null, isAdmin: false },
      }).catch((err) =>
        console.warn(`[technicians/sync] DB upsert failed for "${user.name}":`, err.message)
      );
    }

    console.log(`[technicians/sync] Done — created=${results.created} skipped=${results.skipped} errors=${results.errors.length}`);
    res.json({ data: results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
