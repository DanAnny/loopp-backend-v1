// // scripts/migrations/2025-10-08-fix-chatroom-roomkey-index.js
// import dotenv from "dotenv";
// dotenv.config();

// import mongoose from "mongoose";
// import { connectDB } from "../../src/lib/db.js";
// import { ChatRoom } from "../../src/models/ChatRoom.js";
// import crypto from "crypto";

// const randKey = () => crypto.randomBytes(10).toString("base64url"); // Node 18+

// async function run() {
//   await connectDB();
//   const col = mongoose.connection.collection("chatrooms");

//   // 1) Drop old unique index (non-sparse) if present
//   try {
//     await col.dropIndex("roomKey_1");
//     console.log("✅ Dropped old roomKey_1 index");
//   } catch (e) {
//     if (e.codeName === "IndexNotFound") {
//       console.log("ℹ️ roomKey_1 index not found, continuing");
//     } else {
//       console.error("dropIndex error:", e.message);
//     }
//   }

//   // 2) Backfill roomKey where missing (optional but useful)
//   const cursor = col.find({ $or: [{ roomKey: { $exists: false } }, { roomKey: null }] });
//   let updated = 0;
//   for await (const doc of cursor) {
//     await col.updateOne({ _id: doc._id }, { $set: { roomKey: randKey() } });
//     updated++;
//   }
//   console.log(`✅ Backfilled roomKey on ${updated} rooms`);

//   // 3) Recreate sparse unique index
//   await col.createIndex({ roomKey: 1 }, { unique: true, sparse: true, name: "roomKey_1" });
//   console.log("✅ Created sparse unique index roomKey_1");

//   // 4) Sync indexes through Mongoose model (optional)
//   await ChatRoom.syncIndexes();
//   console.log("✅ ChatRoom.syncIndexes complete");

//   await mongoose.connection.close();
//   console.log("🎉 Migration done");
// }

// run().catch(async (e) => {
//   console.error(e);
//   await mongoose.connection.close();
//   process.exit(1);
// });
