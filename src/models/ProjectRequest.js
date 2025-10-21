// models/ProjectRequest.js
import mongoose from "mongoose";
export const ProjectStatuses = ["Pending", "InProgress", "Review", "Complete"];

const projectRequestSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },
    email:     { type: String, required: true, trim: true, lowercase: true },

    projectTitle:       { type: String, required: false, trim: true },
    projectDescription: { type: String, required: true, trim: true },
    completionDate:     { type: String,   required: true },

    status: { type: String, enum: ProjectStatuses, default: "Pending" },
    pmAssigned:       { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    engineerAssigned: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    chatRoom:         { type: mongoose.Schema.Types.ObjectId, ref: "ChatRoom", default: null },

    // public client auth to chat/rate
    clientKey: { type: String, required: true, unique: true },

    // NEW: link to the authenticated client account
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    ratings: {
      pm:         { score: { type: Number, min: 1, max: 5 }, comment: String },
      engineer:   { score: { type: Number, min: 1, max: 5 }, comment: String },
      coordination:{ score: { type: Number, min: 1, max: 5 }, comment: String },
    },
  },
  { timestamps: true }
);

export const ProjectRequest = mongoose.model("ProjectRequest", projectRequestSchema);
