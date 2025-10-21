// // backend/scripts/seed/demo-engineers.js
// // ✅ Sets password = phone using passport-local-mongoose's setPassword
// // ✅ Fixes gender enum by using capitalized values (e.g., "Male"/"Female")

// import "dotenv/config";
// import mongoose from "mongoose";
// import { connectDB } from "../../src/lib/db.js";
// import { User } from "../../src/models/User.js";

// const engineers = [
//   { firstName: "Ada",    lastName: "Osei",     email: "ada.engineer@loopp.com",    phone: "08010000001", gender: "Female" },
//   { firstName: "Tunde",  lastName: "Bello",    email: "tunde.engineer@loopp.com",  phone: "08010000002", gender: "Male" },
//   { firstName: "Sarah",  lastName: "Okoro",    email: "sarah.engineer@loopp.com",  phone: "08010000003", gender: "Female" },
//   { firstName: "Kofi",   lastName: "Mensah",   email: "kofi.engineer@loopp.com",   phone: "08010000004", gender: "Male" },
//   { firstName: "Ruth",   lastName: "Ibrahim",  email: "ruth.engineer@loopp.com",   phone: "08010000005", gender: "Female" },
// ];

// async function upsertEngineer(e) {
//   // normalize gender to enum your schema expects
//   const gender = ["Male", "Female", "Other"].includes(e.gender) ? e.gender : "Other";

//   const existing = await User.findOne({ email: e.email });

//   if (existing) {
//     existing.firstName = e.firstName;
//     existing.lastName  = e.lastName;
//     existing.phone     = e.phone;
//     existing.gender    = gender;
//     existing.role      = "Engineer";
//     existing.isBusy = existing.isBusy ?? false;
//     existing.numberOfTask = existing.numberOfTask ?? 0;
//     await existing.setPassword(e.phone); // password = phone
//     await existing.save();
//     return existing;
//   }

//   const u = new User({
//     firstName: e.firstName,
//     lastName: e.lastName,
//     email: e.email,
//     phone: e.phone,
//     gender,
//     role: "Engineer",
//     isBusy: false,
//     numberOfTask: 0,
//   });
//   await u.setPassword(e.phone); // password = phone
//   await u.save();
//   return u;
// }

// (async () => {
//   try {
//     await connectDB();
//     console.log("✅ Mongo connected");

//     for (const e of engineers) {
//       const u = await upsertEngineer(e);
//       console.log(`✔ Engineer ${u.firstName} ${u.lastName} (${u.email}) ready. Password = ${u.phone}`);
//     }
//   } catch (e) {
//     console.error(e);
//   } finally {
//     await mongoose.disconnect();
//     process.exit(0);
//   }
// })();
