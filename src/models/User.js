import mongoose from "mongoose";
import passportLocalMongoose from "passport-local-mongoose";

const roles = ["SuperAdmin", "Admin", "PM", "Engineer", "Client"];
const genders = ["Male", "Female"];

const UserSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },
    gender:    { type: String, enum: genders, required: true },

    email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone:     { type: String, required: true, trim: true },

    role:      { type: String, enum: roles, required: true },

    // workload & distribution
    isBusy:             { type: Boolean, default: false },
    numberOfTask:       { type: Number, default: 0 },
    lastDateTaskAssign: { type: Date, default: null },

    // presence
    online:     { type: Boolean, default: false },
    lastActive: { type: Date, default: null },

    // used by force-logout on idle / signout from all sessions
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

UserSchema.plugin(passportLocalMongoose, {
  usernameField: "email",
  errorMessages: { UserExistsError: "Email already exists" },
});

/* ------------ Indexes (CRITICAL for speed) ------------ */
UserSchema.index({ role: 1 });
UserSchema.index({ email: 1 }, { unique: true, sparse: true });
UserSchema.index({ online: 1, lastActive: 1 });                   // presence sweep
UserSchema.index({ isBusy: 1, online: 1, lastActive: 1 });         // PM selection
UserSchema.index({ numberOfTask: 1, lastDateTaskAssign: 1, _id: 1 }); // stable sort for selection
UserSchema.index({ tokenVersion: 1 });                              // auth checks

export const User = mongoose.model("User", UserSchema);
export { roles, genders };
