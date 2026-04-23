const express = require("express");
const { body } = require("express-validator");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { validate } = require("../middleware/validate");
const { getTechnicianByEmail } = require("../lib/mondayClient");

const router = express.Router();

// ──────────────────────────────────────────────────────────
// POST /api/auth/login
//
// Called by the Monday.com frontend after receiving the SDK
// context. Validates the context token (or signing secret),
// upserts the technician, and returns a JWT for all
// subsequent API calls.
//
// Body: {
//   mondayUserId: string,    // monday.com user ID
//   name:         string,    // from monday SDK context
//   email?:       string,
//   isAdmin?:     boolean,   // from monday SDK context.user.isAdmin
//   contextToken?: string,   // monday app context token (optional signature verification)
// }
// ──────────────────────────────────────────────────────────
router.post(
  "/login",
  [
    body("mondayUserId").isString().notEmpty().withMessage("mondayUserId is required"),
    body("name").isString().notEmpty().withMessage("name is required"),
    body("email").optional().isEmail(),
    body("isAdmin").optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { mondayUserId, name, email, isAdmin = false } = req.body;

      // Upsert technician — always sync isAdmin from Monday on every login
      const technician = await prisma.technician.upsert({
        where: { id: String(mondayUserId) },
        update: {
          name,
          isAdmin: Boolean(isAdmin),
          ...(email !== undefined ? { email } : {}),
        },
        create: {
          id:      String(mondayUserId),
          name,
          email:   email ?? null,
          isAdmin: Boolean(isAdmin),
        },
      });

      // Sync hourly rate from the Technicians board (non-blocking — login never fails here)
      if (email) {
        getTechnicianByEmail(email)
          .then(async (boardData) => {
            if (boardData?.hourlyRate > 0) {
              await prisma.technician.update({
                where: { id: String(mondayUserId) },
                data: { burdenRate: boardData.hourlyRate },
              });
              console.log(`[auth] Synced burdenRate=$${boardData.hourlyRate} for ${name}`);
            }
          })
          .catch((err) => console.warn(`[auth] burdenRate sync failed for ${name}:`, err.message));
      }

      const token = jwt.sign(
        {
          sub:     technician.id,
          name:    technician.name,
          isAdmin: technician.isAdmin,
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
      );

      res.json({
        token,
        technician: {
          id:      technician.id,
          name:    technician.name,
          isAdmin: technician.isAdmin,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ──────────────────────────────────────────────────────────
// POST /api/auth/verify
// Lightweight token validity check — returns decoded payload
// ──────────────────────────────────────────────────────────
router.post("/verify", (req, res) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ valid: false, error: "No token" });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    res.json({ valid: true, technician: { id: payload.sub, name: payload.name, isAdmin: payload.isAdmin } });
  } catch {
    res.status(401).json({ valid: false, error: "Token expired or invalid" });
  }
});

module.exports = router;
