import mongoose from "mongoose";

const RefreshTokenSchema = new mongoose.Schema(
  {
    user:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: true },
    revoked:   { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

export const RefreshToken = mongoose.model("RefreshToken", RefreshTokenSchema);
