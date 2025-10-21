// backend/src/services/pm-selection.service.js
import { User } from "../models/User.js";

/**
 * Atomically selects and CLAIMS a PM by incrementing their task count exactly once.
 * Strategy:
 *  1) Prefer a FREE PM (isBusy:false), earliest lastDateTaskAssign.
 *  2) Else pick least-loaded PM, tie-break by earliest lastDateTaskAssign.
 * Returns the updated PM doc (lean).
 */
export const selectAndClaimPM = async () => {
  const now = new Date();

  // 1) Try a FREE PM first (atomic claim)
  let pm = await User.findOneAndUpdate(
    { role: "PM", isBusy: false },
    { $set: { isBusy: true, lastDateTaskAssign: now }, $inc: { numberOfTask: 1 } },
    {
      new: true,
      sort: { lastDateTaskAssign: 1, numberOfTask: 1, _id: 1 },
    }
  ).lean();

  if (pm) return pm;

  // 2) All busy → take the least loaded (atomic claim)
  pm = await User.findOneAndUpdate(
    { role: "PM" },
    { $inc: { numberOfTask: 1 }, $set: { isBusy: true, lastDateTaskAssign: now } },
    {
      new: true,
      sort: { numberOfTask: 1, lastDateTaskAssign: 1, _id: 1 },
    }
  ).lean();

  if (!pm) throw new Error("No PM users exist");
  return pm;
};
