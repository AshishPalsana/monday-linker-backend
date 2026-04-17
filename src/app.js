require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { attachSocketIO } = require("./lib/socketServer");

const technicianRoutes  = require("./routes/technicians");
const timeEntryRoutes   = require("./routes/timeEntries");
const expenseRoutes     = require("./routes/expenses");
const masterCostRoutes  = require("./routes/masterCosts");
const authRoutes        = require("./routes/auth");
const webhookRoutes     = require("./routes/webhooks");
const xeroRoutes        = require("./routes/xero");
const billingRoutes     = require("./routes/billing");
const customerRoutes    = require("./routes/customers");
const { errorHandler }  = require("./middleware/errorHandler");

const app = express();

// ── Security ──────────────────────────────────────────
app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // 1. Allow requests with no origin (e.g. curl, mobile, server-to-server)
      if (!origin) return callback(null, true);

      // 2. Allow explicit origins from .env
      if (allowedOrigins.includes(origin)) return callback(null, true);

      // 3. Robustly allow Monday.com subdomains (dynamic CDN subdomains)
      if (
        origin.endsWith(".monday.app") ||
        origin.endsWith(".monday.com") ||
        /^https:\/\/.*\.monday\.(app|com)$/.test(origin)
      ) {
        return callback(null, true);
      }

      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  })
);

// ── Parsing ────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Logging ────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
}

// ── Health check ───────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Debug Route ────────────────────────────────────────
app.get("/api/debug/counters", async (_req, res) => {
  try {
    const prisma = require("./lib/prisma");
    const counters = await prisma.sequentialIdCounter.findMany();
    res.json({ status: "ok", counters });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ── Routes ─────────────────────────────────────────────
app.use("/api/auth",          authRoutes);
app.use("/api/technicians",   technicianRoutes);
app.use("/api/time-entries",  timeEntryRoutes);
app.use("/api/expenses",      expenseRoutes);
app.use("/api/master-costs",  masterCostRoutes);
app.use("/api/webhooks",      webhookRoutes);
app.use("/api/xero",          xeroRoutes);
app.use("/api/billing",       billingRoutes);
app.use("/api/customers",     customerRoutes);

// ── 404 ────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ── Error handler ──────────────────────────────────────
app.use(errorHandler);

// ── Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const { httpServer } = attachSocketIO(app);
const { runRecoverySweep } = require("./services/customerSyncService");

httpServer.listen(PORT, async () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`[server] Socket.io attached`);

  // Verify DB connection
  const prisma = require("./lib/prisma");
  try {
    await prisma.$connect();
    console.log("[server] ✓ Database connected");
  } catch (err) {
    console.error("[server] ✗ Database connection failed:", err.message);
    // On Render, we might want to exit to trigger a restart, 
    // but for now, we'll let it stay up so the health check can return a 500.
  }

  // Start-up recovery sweep for Customers
  runRecoverySweep();
});

module.exports = app;
