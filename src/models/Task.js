// backend/src/models/Task.js
import mongoose from "mongoose";

export const TaskStatuses = ["Pending", "InProgress", "Complete"];

/**
 * Coerce strings/numbers into real Date objects.
 * If the value is a YYYY-MM-DD string, normalize it to end-of-day local time.
 */
function toCoercedDateOrNull(v) {
  if (!v) return null;

  if (v instanceof Date && !isNaN(v)) {
    return v;
  }

  const d = new Date(v);
  if (isNaN(d)) return null;

  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    d.setHours(23, 59, 59, 999);
  }
  return d;
}

const taskSchema = new mongoose.Schema(
  {
    request:  { type: mongoose.Schema.Types.ObjectId, ref: "ProjectRequest", required: true },
    pm:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    engineer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    title:       { type: String, required: true },
    description: { type: String, required: true },

    status:   { type: String, enum: TaskStatuses, default: "Pending" },
    deadline: { type: Date, default: null }, // PM-set deadline (always a real Date after coercion)
  },
  { timestamps: true }
);

// Coerce 'deadline' on create/save
taskSchema.pre("save", function(next) {
  if (this.isModified("deadline")) {
    this.deadline = toCoercedDateOrNull(this.deadline);
  }
  next();
});

// Coerce 'deadline' on updates
taskSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function(next) {
  const upd = this.getUpdate() || {};
  if (Object.prototype.hasOwnProperty.call(upd, "deadline")) {
    upd.deadline = toCoercedDateOrNull(upd.deadline);
    this.setUpdate(upd);
  }
  if (upd.$set && Object.prototype.hasOwnProperty.call(upd.$set, "deadline")) {
    upd.$set.deadline = toCoercedDateOrNull(upd.$set.deadline);
    this.setUpdate(upd);
  }
  next();
});

export const Task = mongoose.model("Task", taskSchema);
