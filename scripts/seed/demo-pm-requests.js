// node scripts/seed/demo-pm-requests.js
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import crypto from "crypto";
import { connectDB } from "../../src/lib/db.js";
import { User } from "../../src/models/User.js";
import { ProjectRequest } from "../../src/models/ProjectRequest.js";
import { ChatRoom } from "../../src/models/ChatRoom.js";
import { generateClientKey } from "../../src/utils/token.utils.js";

const EXISTING_PM_ID = "68e5476661222210ed1a57a4";
const SEED_TAG = process.env.SEED_TAG || new Date().toISOString().slice(0,10); // e.g. 2025-10-08

// default fields for a *new* PM doc (NO 'role' here to avoid conflicts)
const basePMInsert = (overrides = {}) => ({
  firstName: "PM",
  lastName: Math.random().toString(36).slice(-4),
  phone: "+2348000000000",
  gender: "Male",
  isBusy: false,
  numberOfTask: 0,
  ...overrides,
});

function roomKey() {
  return crypto.randomBytes(10).toString("base64url");
}

// Upsert by email (idempotent). Only $set role, never put role in $setOnInsert.
async function upsertPMByEmail(email, overrides = {}) {
  const $setOnInsert = { ...basePMInsert(overrides), email };
  // Ensure 'role' is not accidentally included in $setOnInsert
  delete $setOnInsert.role;

  const update = {
    $setOnInsert,
    $set: { role: "PM" }, // upgrade role if user already exists
  };

  const doc = await User.findOneAndUpdate(
    { email },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc;
}

// Ensure by _id. If it exists, upgrade role if needed; else create a new doc with role: 'PM'.
async function ensurePMById(_id, overrides = {}) {
  let doc = await User.findById(_id);
  if (doc) {
    if (doc.role !== "PM") {
      doc.role = "PM";
      await doc.save();
    }
    return doc;
  }
  const payload = {
    ...basePMInsert(overrides),
    _id,
    email: overrides.email || `pm-${String(_id).slice(-6)}@loopp.com`,
    role: "PM", // safe on create
  };
  return User.create(payload);
}

async function alreadySeeded() {
  return ProjectRequest.countDocuments({
    projectDescription: new RegExp(`\\[SEED:${SEED_TAG}\\]`, "i"),
  });
}

async function run() {
  await connectDB();
  console.log("✅ MongoDB connected");

  // --- PMs (idempotent) ---
  const pm1 = await upsertPMByEmail("amara.pm@loopp.com", { firstName: "Amara", lastName: "Okoye", phone: "+2348000000001" });
  const pm2 = await upsertPMByEmail("jide.pm@loopp.com",   { firstName: "Jide",  lastName: "Afolabi", phone: "+2348000000002" });
  const pm3 = await ensurePMById(EXISTING_PM_ID, { firstName: "Existing", lastName: "PM", phone: "+2348000000003" });

  const pms = [pm1, pm2, pm3];

  // --- Skip if already seeded for this tag ---
  const seededCount = await alreadySeeded();
  if (seededCount >= 10) {
    console.log(`ℹ️ Already seeded ${seededCount} requests with tag [SEED:${SEED_TAG}] — skipping.`);
    await mongoose.connection.close();
    return;
  }

  // --- Create 10 project requests, assign round-robin, create rooms ---
  const titles = [
    "Marketing Site Revamp", "Data Pipeline Setup", "Mobile App MVP",
    "Checkout Optimization", "Onboarding Flow", "Analytics Dashboard",
    "SEO Audit Tool", "Internal Admin Portal", "Landing Page Experiment",
    "Subscription Billing Integration",
  ];
  const firstNames = ["Ada", "Yemi", "Kunle", "Chi", "Halima"];
  const lastNames  = ["Okafor", "Adebayo", "Balogun", "Eze", "Garba"];

  const created = [];
  for (let i = 0; i < 10; i++) {
    const assignedPM = pms[i % pms.length];
    const projectTitle = titles[i];
    const firstName = firstNames[i % firstNames.length];
    const lastName  = lastNames[i % lastNames.length];
    const email = `client${i+1}@example.com`;

    const req = await ProjectRequest.create({
      firstName, lastName, email,
      projectTitle,
      projectDescription: `Auto-seeded [SEED:${SEED_TAG}] #${i+1}`,
      completionDate: new Date(Date.now() + 1000*60*60*24*(14 + i)),
      status: "Pending",
      pmAssigned: assignedPM._id,
      clientKey: generateClientKey(),
    });

    const roomTitle = `${projectTitle} - ${firstName} - ${req._id.toString().slice(-5)}`;
    const room = await ChatRoom.create({
      title: roomTitle,
      members: [assignedPM._id], // engineer joins once they accept
      request: req._id,
      roomKey: roomKey(),
      lastMessage: { text: "", at: null, sender: null },
    });

    req.chatRoom = room._id;
    await req.save();

    created.push({
      reqId: req._id.toString(),
      roomId: room._id.toString(),
      pmId: assignedPM._id.toString(),
      roomKey: room.roomKey,
    });
  }

  console.log("✅ Seeded/ensured PMs:", pms.map(p => ({ id: p._id.toString(), email: p.email })));
  console.log("✅ Seeded Requests:", created);
  await mongoose.connection.close();
}

run().catch(async (e) => {
  console.error(e);
  await mongoose.connection.close();
  process.exit(1);
});
