import mongoose from "mongoose";
import passportLocalMongoose from "passport-local-mongoose";

const roles = ["SuperAdmin", "Admin", "PM", "Engineer"];
const genders = ["Male", "Female"];

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },
    gender:    { type: String, enum: genders, required: true },
    email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone:     { type: String, required: true, trim: true },
    role:      { type: String, enum: roles },

    // workload & distribution
    isBusy:            { type: Boolean, default: false },
    numberOfTask:      { type: Number, default: 0 },
    lastDateTaskAssign:{ type: Date, default: null },

    // presence
    online:     { type: Boolean, default: false },
    lastActive: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.plugin(passportLocalMongoose, {
  usernameField: "email",
  errorMessages: { UserExistsError: "Email already exists" },
});

export const User = mongoose.model("User", userSchema);
export { roles, genders };
