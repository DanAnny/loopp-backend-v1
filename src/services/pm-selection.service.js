import { User } from "../models/User.js";

/**
 * A PM is considered "online & active" only if lastActive is within this window.
 * Keep it strict so only truly active users qualify.
 */
export const ONLINE_WINDOW_MS = 10 * 1000; // 10 seconds

export function onlineActiveFilter() {
  return {
    online: true,
    lastActive: { $gte: new Date(Date.now() - ONLINE_WINDOW_MS) },
  };
}

/**
 * Ensure we never select a stale "online" PM.
 * This runs immediately before any selection attempt.
 */
async function pruneStaleOnlineFlags() {
  const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS);
  try {
    await User.updateMany(
      { role: "PM", online: true, lastActive: { $lt: cutoff } },
      { $set: { online: false } }
    );
  } catch {
    // best effort; ignore failures
  }
}

// Make null lastDateTaskAssign sort first (Mongo does this by default asc)
const sortByLoad = {
  numberOfTask: 1,
  lastDateTaskAssign: 1,
  _id: 1,
};

/**
 * Select & claim an ONLINE PM (strict), preferring free first.
 */
export const selectAndClaimOnlinePM = async () => {
  const now = new Date();

  // harden against stale flags before picking
  await pruneStaleOnlineFlags();

  // Prefer free PMs who are strictly online
  let pm = await User.findOneAndUpdate(
    { role: "PM", isBusy: false, ...onlineActiveFilter() },
    { $set: { isBusy: true, lastDateTaskAssign: now }, $inc: { numberOfTask: 1 } },
    { new: true, sort: sortByLoad }
  ).lean();
  if (pm) return pm;

  // Else pick strictly online (even if currently marked busy), least-loaded
  pm = await User.findOneAndUpdate(
    { role: "PM", ...onlineActiveFilter() },
    { $set: { isBusy: true, lastDateTaskAssign: now }, $inc: { numberOfTask: 1 } },
    { new: true, sort: sortByLoad }
  ).lean();

  return pm || null;
};

/**
 * Try to claim one specific PM (usually because they just became active).
 */
export const tryClaimSpecificPM = async (
  pmId,
  { preferFree = true, allowBusyFallback = true } = {}
) => {
  const now = new Date();

  // harden against stale flags before picking
  await pruneStaleOnlineFlags();

  const base = { _id: pmId, role: "PM", ...onlineActiveFilter() };

  if (preferFree) {
    const freePick = await User.findOneAndUpdate(
      { ...base, isBusy: false },
      { $set: { isBusy: true, lastDateTaskAssign: now }, $inc: { numberOfTask: 1 } },
      { new: true }
    ).lean();
    if (freePick) return freePick;
  }

  if (allowBusyFallback) {
    const busyPick = await User.findOneAndUpdate(
      base,
      { $set: { isBusy: true, lastDateTaskAssign: now }, $inc: { numberOfTask: 1 } },
      { new: true }
    ).lean();
    if (busyPick) return busyPick;
  }

  return null;
};
