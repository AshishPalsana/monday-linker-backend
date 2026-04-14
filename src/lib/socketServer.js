// Singleton Socket.io server instance shared across the app.
// Usage: const { io } = require('./socketServer');

const { Server } = require("socket.io");
const http = require("http");
const prisma = require("./prisma");
const { getCSTDayBounds, getCSTRangeBounds } = require("./cstTime");

let io = null;

/**
 * Attach Socket.io to an existing Express app and return the http.Server.
 * @param {import('express').Express} app
 * @returns {{ httpServer: http.Server, io: import('socket.io').Server }}
 */
function attachSocketIO(app) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const httpServer = http.createServer(app);

  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins.length ? allowedOrigins : "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
    // Let socket.io handle its own upgrade path — Express handles everything else
    path: "/socket.io",
  });

  io.on("connection", (socket) => {
    const { technicianId, role } = socket.handshake.auth;

    if (role === "admin") {
      socket.join("admins");
    }
    if (technicianId) {
      // Each technician gets their own room so targeted events are easy
      socket.join(`tech:${technicianId}`);
    }

    // ── Technician: fetch their own today's entries ────────────────────────
    socket.on("today:request", async () => {
      if (!technicianId) return;
      try {
        const { dayStart, dayEnd } = getCSTDayBounds();

        const include = {
          expenses: true,
          technician: { select: { id: true, name: true } },
        };

        // Fetch today's entries AND any open entry from a previous day in parallel.
        // An open entry from a previous session (e.g. browser closed without clocking out)
        // must be included so the frontend can restore the active clock-in state.
        const [todayEntries, staleOpenEntry] = await Promise.all([
          prisma.timeEntry.findMany({
            where: { technicianId, clockIn: { gte: dayStart, lte: dayEnd } },
            include,
            orderBy: { clockIn: "asc" },
          }),
          prisma.timeEntry.findFirst({
            where: { technicianId, clockOut: null, clockIn: { lt: dayStart } },
            include,
            orderBy: { clockIn: "desc" },
          }),
        ]);

        // Prepend the stale open entry so the frontend reconciler finds it first
        const entries = staleOpenEntry
          ? [staleOpenEntry, ...todayEntries]
          : todayEntries;

        socket.emit("today:data", { data: entries });
      } catch (err) {
        console.error("[socket] today:request error:", err.message);
        socket.emit("today:error", { message: "Failed to load today's entries" });
      }
    });

    // ── Admin: fetch TimeBoard data by date range ──────────────────────────
    socket.on("board:request", async ({ from, to } = {}) => {
      // Temporarily disabled for testing — admin check bypassed
      // if (role !== "admin") {
      //   socket.emit("board:error", { message: "Admin access required to view the Time Board." });
      //   return;
      // }
      if (!from || !to) return;
      try {
        const { rangeStart, rangeEnd } = getCSTRangeBounds(from, to);

        const entries = await prisma.timeEntry.findMany({
          where: { clockIn: { gte: rangeStart, lte: rangeEnd } },
          include: {
            expenses: true,
            technician: { select: { id: true, name: true } },
          },
          orderBy: [{ clockIn: "asc" }, { technicianId: "asc" }],
        });

        socket.emit("board:data", { from, to, data: entries });
      } catch (err) {
        console.error("[socket] board:request error:", err.message);
        socket.emit("board:error", { message: "Failed to load board data" });
      }
    });

    socket.on("disconnect", () => {
      // nothing to clean up — rooms are auto-left on disconnect
    });
  });

  return { httpServer, io };
}

/**
 * Emit a time-tracking event to all relevant listeners.
 * @param {"clock_in" | "clock_out"} event
 * @param {object} payload
 */
function emitTimeEvent(event, payload) {
  if (!io) return; // socket server not yet initialised (unit tests, etc.)
  io.to("admins").emit(event, payload);
  if (payload.technicianId) {
    io.to(`tech:${payload.technicianId}`).emit(event, payload);
  }
}

module.exports = { attachSocketIO, emitTimeEvent };
