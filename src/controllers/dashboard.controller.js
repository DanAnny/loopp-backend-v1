import * as dashboardService from "../services/dashboard.service.js";

export const overview = async (req, res) => {
  try {
    const { range = "month" } = req.query;
    const data = await dashboardService.overview({ range });
    res.json({ success: true, data });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
