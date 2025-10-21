import * as userService from "../services/user.service.js";
import { User } from "../models/User.js";

export const getEngineers = async (req, res) => {
  try {
    const { isBusy } = req.query;
    const engineers = await userService.listEngineers({ isBusy: typeof isBusy === "string" ? isBusy === "true" : undefined });
    res.json({ success: true, engineers });
  } catch (e) {
    res.status(400).json({ success:false, message:e.message });
  }
};

export const getPMs = async (req, res) => {
  try {
    const { isBusy } = req.query;
    const pms = await userService.listPMs({ isBusy: typeof isBusy === "string" ? isBusy === "true" : undefined });
    res.json({ success: true, pms });
  } catch (e) {
    res.status(400).json({ success:false, message:e.message });
  }
};

export const getAll = async (req, res) => {
  try {
    const users = await userService.listAllUsers();
    res.json({ success: true, users });
  } catch (error) {
    res.status(400).json({ success:false, message:error.message });
  }
}
