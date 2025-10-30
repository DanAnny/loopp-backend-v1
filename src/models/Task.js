import mongoose from "mongoose";

export const TaskStatuses = ["Pending", "InProgress", "Complete"];

/** Normalize incoming deadline values to Date (EOD for YYYY-MM-DD & DMY).
 * Accepts: Date, ISO, YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY.
 * Returns null if invalid/empty.
 */
function toCoercedDateOrNull(v) {
  if (v == null || v === "" || (typeof v === "string" && v.trim() === "")) return null;
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === "number") return new Date(v);

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T23:59:59.999Z`);

    // DD/MM/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
      const [d, m, y] = s.split("/").map(Number);
      return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
    }

    // DD-MM-YYYY
    if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
      const [d, m, y] = s.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
    }

    // MM/DD/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
      // already handled above as DMY; to be explicit we keep ISO fallback below
    }

    // Fallback: let Date parse ISO and similar
    const iso = new Date(s);
    if (!isNaN(iso)) return iso;
  }

  return null;
}

const TaskSchema = new mongoose.Schema(
  {
    request:  { type: mongoose.Schema.Types.ObjectId, ref: "ProjectRequest", required: true },
    pm:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    engineer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    title:       { type: String, required: true },
    description: { type: String, required: true },

    status:   { type: String, enum: TaskStatuses, default: "Pending" },

    // ✅ Setter ensures EVERY write path coerces deadline
    deadline: { type: Date, default: null, set: toCoercedDateOrNull },
  },
  { timestamps: true }
);

/* Safety nets for legacy update code paths */
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
export { toCoercedDateOrNull };
