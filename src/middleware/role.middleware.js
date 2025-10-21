export const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Insufficient permissions.",
      });
    }
    next();
  };
};

export function requirePm(req, res, next) {
  try {
    const role = (req.user?.role || "").toString();
    if (/^pm$/i.test(role)) return next();
    return res.status(403).json({ message: "Only PMs can create Zoom meetings." });
  } catch (e) {
    return res.status(401).json({ message: "Unauthorized" });
  }
}