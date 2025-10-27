import mongoose from "mongoose";

export const TaskStatuses = ["Pending", "InProgress", "Complete"];

/** Normalize incoming deadline values to real Dates (end-of-day for YYYY-MM-DD). */
function toCoercedDateOrNull(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return v;

  const d = new Date(v);
  if (isNaN(d)) return null;

  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    d.setHours(23, 59, 59, 999);
  }
  return d;
}

const TaskSchema = new mongoose.Schema(
  {
    request:  { type: mongoose.Schema.Types.ObjectId, ref: "ProjectRequest", required: true },
    pm:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    engineer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    title:       { type: String, required: true },
    description: { type: String, required: true },

    status:   { type: String, enum: TaskStatuses, default: "Pending" },
    deadline: { type: Date, default: null },
  },
  { timestamps: true }
);

/* Normalize deadline on save/update */
TaskSchema.pre("save", function(next) {
  if (this.isModified("deadline")) this.deadline = toCoercedDateOrNull(this.deadline);
  next();
});
TaskSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function(next) {
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

/* ------------ Indexes ------------ */
TaskSchema.index({ request: 1, createdAt: -1 });
TaskSchema.index({ pm: 1, status: 1, createdAt: -1 });
TaskSchema.index({ engineer: 1, status: 1, createdAt: -1 });
TaskSchema.index({ deadline: 1, status: 1 });

export const Task = mongoose.model("Task", TaskSchema);
