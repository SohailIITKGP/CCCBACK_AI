/**
 * Express middleware factory that gates a route to a set of allowed roles.
 *
 * MUST be used after `authMiddleware` (which populates `req.user`).
 *
 * Example:
 *   router.delete("/:id", authMiddleware, requireRoles("Super Admin", "Manager"), handler);
 */
const requireRoles = (...allowedRoles) => {
  const allowed = new Set(allowedRoles);
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    return next();
  };
};

// Convenient role bundles that mirror the existing patterns in this codebase.
const WRITE_ROLES = [
  "Super Admin",
  "Manager",
  "BO-Client",
  "Lead-Employee",
  "Product-Manager",
];

const ADMIN_ROLES = ["Super Admin", "Manager"];

module.exports = {
  requireRoles,
  WRITE_ROLES,
  ADMIN_ROLES,
};
