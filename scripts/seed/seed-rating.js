// scripts/seed-rating.js
import mongoose from "mongoose";
import { ProjectRequest } from "../../src/models/ProjectRequest.js";
import { config } from "../../src/config/env.js"; // must export mongoURI

const REQ_ID = "68e68b13abac0a03a2092078";

async function main() {
  await mongoose.connect(config.mongoURI, { dbName: undefined }); // or specify dbName if you use one
  const res = await ProjectRequest.findByIdAndUpdate(
    REQ_ID,
    {
      $set: {
        "ratings.pm":           { score: 5, comment: "Great coordination and clarity." },
        "ratings.engineer":     { score: 4, comment: "Solid implementation, minor tweaks left." },
        "ratings.coordination": { score: 5, comment: "Smooth process end-to-end." },
        updatedAt: new Date(),
      },
    },
    { new: true }
  ).lean();

  if (!res) {
    console.error("ProjectRequest not found:", REQ_ID);
  } else {
    console.log("Updated ratings:", res.ratings);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
