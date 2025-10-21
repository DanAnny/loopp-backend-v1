import { ProjectRequest } from "../models/ProjectRequest.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";

const rangeToDates = (range) => {
  const now = new Date();
  let from;
  if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    const startMonth = q * 3;
    from = new Date(now.getFullYear(), startMonth, 1);
  } else {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  // normalize
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0, 0);
  const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { from: start, to: end };
};

const dayKey = (d) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0,10);

export const overview = async ({ range = "month" }) => {
  const { from, to } = rangeToDates(range);

  // ---- Totals (all-time + in-range) ----
  const [totalRequestsAll] = await Promise.all([
    ProjectRequest.countDocuments({}),
  ]);

  // In-range requests by lifecycle
  const requestedInRange = await ProjectRequest.countDocuments({ createdAt: { $gte: from, $lte: to } });
  const assignedInRange  = await ProjectRequest.countDocuments({ engineerAssigned: { $exists: true, $ne: null }, updatedAt: { $gte: from, $lte: to } });

  // "Accepted by Engineers" → tasks accepted (status InProgress) in range
  const acceptedTasks = await Task.countDocuments({ status: "InProgress", updatedAt: { $gte: from, $lte: to } });

  // "Completed" → project requests completed in range
  const completedInRange = await ProjectRequest.countDocuments({ status: "Complete", updatedAt: { $gte: from, $lte: to } });

  // Staff breakdown
  const [pmCount, engCount, adminCount, totalStaff] = await Promise.all([
    User.countDocuments({ role: "PM" }),
    User.countDocuments({ role: "Engineer" }),
    User.countDocuments({ role: "Admin" }),
    User.countDocuments({ role: { $in: ["PM","Engineer","Admin"] } }),
  ]);

  // Active/Idle (busy OR online = active)
  const [activePMs, idlePMs, activeEngineers, idleEngineers] = await Promise.all([
    User.countDocuments({ role: "PM",        $or: [{ isBusy: true }, { online: true }] }),
    User.countDocuments({ role: "PM",        isBusy: false, online: false }),
    User.countDocuments({ role: "Engineer",  $or: [{ isBusy: true }, { online: true }] }),
    User.countDocuments({ role: "Engineer",  isBusy: false, online: false }),
  ]);

  const totals = {
    totalRequests: totalRequestsAll,
    assignedThisRange: assignedInRange,
    acceptedThisRange: acceptedTasks,
    completedThisRange: completedInRange,
    staff: { total: totalStaff, pm: pmCount, engineer: engCount, admin: adminCount },
    activePMs, idlePMs, activeEngineers, idleEngineers,
  };

  // ---- Charts (daily pipeline + role bars) ----
  // Build day buckets
  const days = [];
  const cursor = new Date(from);
  while (cursor <= to) {
    days.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  const requestsInRange = await ProjectRequest.find({
    $or: [
      { createdAt: { $gte: from, $lte: to } },
      { updatedAt: { $gte: from, $lte: to } },
    ],
  }).select("createdAt updatedAt engineerAssigned status").lean();

  const tasksInRange = await Task.find({
    updatedAt: { $gte: from, $lte: to },
  }).select("status updatedAt").lean();

  // init series
  const daily = new Map(days.map((d) => [d, { date: d, requested: 0, assigned: 0, accepted: 0, completed: 0 }]));

  for (const pr of requestsInRange) {
    const createdDay = dayKey(new Date(pr.createdAt));
    if (daily.has(createdDay)) daily.get(createdDay).requested += 1;

    if (pr.engineerAssigned) {
      const upd = dayKey(new Date(pr.updatedAt || pr.createdAt));
      if (daily.has(upd)) daily.get(upd).assigned += 1;
    }
    if (pr.status === "Complete") {
      const upd = dayKey(new Date(pr.updatedAt || pr.createdAt));
      if (daily.has(upd)) daily.get(upd).completed += 1;
    }
  }

  for (const t of tasksInRange) {
    if (t.status === "InProgress") {
      const upd = dayKey(new Date(t.updatedAt));
      if (daily.has(upd)) daily.get(upd).accepted += 1;
    }
  }

  const lineSeries = Array.from(daily.values());

  const roleBars = [
    { role: "PM",       active: activePMs,      idle: idlePMs,       total: pmCount },
    { role: "Engineer", active: activeEngineers, idle: idleEngineers, total: engCount },
    { role: "Admin",    active: 0,              idle: 0,             total: adminCount },
  ];

  // ---- Staff ratings & idle engineers (example) ----
  const completed = await ProjectRequest.find({
    status: "Complete",
    updatedAt: { $gte: from, $lte: to },
  }).select("ratings pmAssigned engineerAssigned").lean();

  const ratingAgg = {};
  for (const p of completed) {
    // PM
    if (p.pmAssigned && p.ratings?.pm?.score) {
      const k = `pm:${String(p.pmAssigned)}`;
      ratingAgg[k] = ratingAgg[k] || { id: String(p.pmAssigned), role: "PM", sum: 0, count: 0 };
      ratingAgg[k].sum += Number(p.ratings.pm.score);
      ratingAgg[k].count += 1;
    }
    // Engineer
    if (p.engineerAssigned && p.ratings?.engineer?.score) {
      const k = `eng:${String(p.engineerAssigned)}`;
      ratingAgg[k] = ratingAgg[k] || { id: String(p.engineerAssigned), role: "Engineer", sum: 0, count: 0 };
      ratingAgg[k].sum += Number(p.ratings.engineer.score);
      ratingAgg[k].count += 1;
    }
  }

  const ids = Object.values(ratingAgg).map((x) => x.id);
  const users = await User.find({ _id: { $in: ids } }).select("firstName lastName email").lean();
  const uMap = new Map(users.map(u => [String(u._id), u]));

  const staffRatings = Object.values(ratingAgg)
    .map(x => {
      const u = uMap.get(x.id);
      const name = u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() || "User" : "User";
      return { id: x.id, name, role: x.role, avg: x.count ? x.sum / x.count : 0, count: x.count };
    })
    .sort((a,b) => b.avg - a.avg || b.count - a.count)
    .slice(0, 8);

  // Idle engineers = engineers with 0 accepted tasks in the range
  const acceptedTaskEngineerIds = await Task.distinct("engineer", {
    status: "InProgress",
    updatedAt: { $gte: from, $lte: to },
  });

  const idleEngineersList = await User.find({
    role: "Engineer",
    _id: { $nin: acceptedTaskEngineerIds },
  }).select("firstName lastName email role").lean();

  const staff = {
    ratings: staffRatings.map(s => ({
      id: s.id,
      name: s.name,
      role: s.role,
      avg: s.avg,
      count: s.count,
    })),
    idle: idleEngineersList.map(u => ({
      id: String(u._id),
      name: `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Engineer",
      email: u.email || "",
      role: u.role,
    })),
  };

  return {
    range: { from, to },
    totals,
    charts: { lineSeries, roleBars },
    staff,
  };
};
