import { User } from "../models/User.js";

/**
 * Sync isBusy flag with numberOfTask count
 */
export const syncUserBusyStatus = async (userId) => {
  const user = await User.findById(userId);
  if (!user) return;
  const busy = user.numberOfTask > 0;
  if (user.isBusy !== busy) {
    user.isBusy = busy;
    await user.save();
  }
};
