// backend/src/controllers/task.controller.js
import * as taskService from "../services/task.service.js";
import { fromReq } from "../services/audit.service.js";
import { ProjectRequest } from "../models/ProjectRequest.js";
import { getIO } from "../lib/io.js";
import mongoose from "mongoose";

export const createTask = async (req, res) => {
  try {
    const { requestId, engineerId, title, description, deadline } = req.body;
    const task = await taskService.createTaskForRequest(
      { requestId, pmUser: req.user, engineerId, title, description, deadline },
      fromReq(req)
    );

    // real-time notify assigned engineer
    const reqDoc = await ProjectRequest.findById(requestId).lean();
    getIO()?.to(`user:${engineerId}`).emit("task:assigned", {
      taskId: task._id,
      title: task.title,
      requestId,
      roomId: reqDoc?.chatRoom || null,
      roomKey: null,
    });

    res.status(201).json({ success: true, task });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listByEngineer = async (req, res) => {
  try {
    const { engineerId } = req.params;
    if (req.user.role !== "Engineer" || req.user._id.toString() !== engineerId)
      return res.status(403).json({ success: false, message: "Forbidden" });

    const tasks = await taskService.getTasksForEngineer(engineerId);
    res.json({ success: true, tasks });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const acceptTask = async (req, res) => {
  try {
    const { taskId } = req.body;
    const { task, roomId, roomKey } = await taskService.engineerAcceptTask(
      taskId,
      req.user,
      fromReq(req)
    );
    res.json({ success: true, task, roomId, roomKey });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const completeTask = async (req, res) => {
  try {
    const { taskId } = req.body;
    const task = await taskService.engineerCompleteTask(taskId, req.user, fromReq(req));
    res.json({ success: true, task });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const summaryByEngineer = async (req, res) => {
  try {
    const { engineerId } = req.params;

    if (!mongoose.isValidObjectId(engineerId)) {
      return res.status(400).json({ success: false, message: "Invalid engineerId" });
    }

    if (req.user.role !== "Engineer" || req.user._id.toString() !== engineerId) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const summary = await taskService.getEngineerTaskSummary(engineerId);
    res.json({ success: true, summary });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
