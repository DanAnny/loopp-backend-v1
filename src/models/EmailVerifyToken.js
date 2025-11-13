import mongoose from "mongoose";

const EmailVerifyTokenSchema = new mongoose.Schema(
  {
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    tokenHash:{ type: String, required: true, unique: true },
    expiresAt:{ type: Date, required: true, index: true },
    usedAt:   { type: Date, default: null },
  },
  { timestamps: true }
);

EmailVerifyTokenSchema.index({ userId: 1, expiresAt: 1 });

export const EmailVerifyToken = mongoose.model("EmailVerifyToken", EmailVerifyTokenSchema);
