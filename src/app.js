require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { attachSocketIO } = require("./lib/socketServer");

const technicianRoutes = require("./routes/technicians");
const timeEntryRoutes  = require("./routes/timeEntries");
const expenseRoutes    = require("./routes/expenses");
const authRoutes       = require("./routes/auth");
const webhookRoutes    = require("./routes/webhooks");
const { errorHandler } = require("./middleware/errorHandler");

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
      // Allow requests with no origin (e.g. curl, mobile, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
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
app.use("/api/auth",         authRoutes);
app.use("/api/technicians",  technicianRoutes);
app.use("/api/time-entries", timeEntryRoutes);
app.use("/api/expenses",     expenseRoutes);
app.use("/api/webhooks",     webhookRoutes);

// ── 404 ────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ── Error handler ──────────────────────────────────────
app.use(errorHandler);

// ── Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const { httpServer } = attachSocketIO(app);
httpServer.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`[server] Socket.io attached`);
});

module.exports = app;
