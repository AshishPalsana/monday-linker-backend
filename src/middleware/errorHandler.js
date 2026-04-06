function errorHandler(err, req, res, _next) {
  if (err.message && err.message.startsWith("CORS:")) {
    return res.status(403).json({ error: err.message });
  }

  if (err.code === "P2025") {
    return res.status(404).json({ error: "Record not found" });
  }

  if (err.code === "P2002") {
    return res.status(409).json({ error: "Record already exists" });
  }

  console.error("[error]", err);
  const status = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === "production"
    ? "Internal server error"
    : err.message || "Internal server error";

  res.status(status).json({ error: message });
}

module.exports = { errorHandler };
