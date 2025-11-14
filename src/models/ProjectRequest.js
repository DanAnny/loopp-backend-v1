import mongoose from "mongoose";

export const ProjectStatuses = ["Pending", "InProgress", "Review", "Complete"];

const ProjectRequestSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },
    email:     { type: String, required: true, trim: true, lowercase: true },

    projectTitle:       { type: String, required: false, trim: true },
    projectDescription: { type: String, required: true, trim: true },
    completionDate:     { type: String, required: true },

    status:            { type: String, enum: ProjectStatuses, default: "Pending" },
    pmAssigned:        { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    engineerAssigned:  { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    chatRoom:          { type: mongoose.Schema.Types.ObjectId, ref: "ChatRoom", default: null },

    clientKey: { type: String, required: true, unique: true },

    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    ratings: {
      pm:           { score: { type: Number, min: 1, max: 5 }, comment: String },
      engineer:     { score: { type: Number, min: 1, max: 5 }, comment: String },
      coordination: { score: { type: Number, min: 1, max: 5 }, comment: String },
    },

    lastMeet: {
      url:       { type: String },
      eventId:   { type: String },
      start:     { type: String },
      end:       { type: String },
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
  },
  { timestamps: true }
);

/* ------------ Indexes ------------ */
ProjectRequestSchema.index({ chatRoom: 1 });
ProjectRequestSchema.index({ status: 1, createdAt: 1 });  // standby picker order
ProjectRequestSchema.index({ pmAssigned: 1, status: 1 }); // safeSetPmAssigned cas
ProjectRequestSchema.index({ clientId: 1 });
ProjectRequestSchema.index({ email: 1, createdAt: -1 });

export const ProjectRequest = mongoose.model("ProjectRequest", ProjectRequestSchema);
