import { GridFSBucket } from "mongodb";
import mongoose, { Types } from "mongoose";
import { pipeline as nodePipeline } from "node:stream";
import { promisify } from "node:util";

const pipeline = promisify(nodePipeline);

let bucket = null;

export const initGridFS = () => {
  if (!mongoose.connection?.db) return;
  // ⚠️ Must match the bucket used for uploads
  bucket = new GridFSBucket(mongoose.connection.db, { bucketName: "uploads" });
};

export const getBucket = () => {
  if (!bucket) initGridFS();
  return bucket;
};

// unchanged: for uploads
export const uploadBufferToGridFS = async ({ buffer, filename, contentType }) => {
  const b = getBucket();
  return new Promise((resolve, reject) => {
    try {
      const uploadStream = b.openUploadStream(filename || "file", { contentType });
      uploadStream.once("error", reject);
      uploadStream.once("finish", async () => {
        try {
          const files = await b.find({ _id: uploadStream.id }).toArray();
          const file = files?.[0];
          if (!file) return reject(new Error("GridFS file not found after upload"));
          resolve({
            fileId: file._id,
            filename: file.filename,
            contentType: file.contentType || contentType || "application/octet-stream",
            length: file.length,
          });
        } catch (e) {
          reject(e);
        }
      });
      uploadStream.end(buffer);
    } catch (e) {
      reject(e);
    }
  });
};

/**
 * Robust streamer with Range support.
 * - Supports inline preview for images/PDF unless asAttachment=true
 * - Handles Range: bytes=...
 * - Always ends/cleans up to avoid hanging tabs
 */
export const streamFileByIdHTTP = async (req, res, id, { asAttachment = false, filenameOverride } = {}) => {
  const b = getBucket();

  // Validate id
  let _id;
  try {
    _id = typeof id === "string" ? new Types.ObjectId(id) : id;
  } catch {
    res.status(400).end();
    return;
  }

  // Read file doc first (so we know length, type, name)
  const files = await b.find({ _id }).toArray();
  if (!files?.length) {
    res.status(404).end();
    return;
  }
  const file = files[0];
  const mime = file.contentType || "application/octet-stream";
  const name = filenameOverride || file.filename || "file";
  const total = Number(file.length);

  const isInlineType = mime.startsWith("image/") || mime === "application/pdf";
  const inline = !asAttachment && isInlineType;

  // Base headers
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", mime);
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(name)}"`
  );
  // Caching helps thumbnails
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");

  // Handle Range (e.g. PDF viewers)
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    let start = startStr ? parseInt(startStr, 10) : 0;
    let end = endStr ? parseInt(endStr, 10) : total - 1;

    // sanitize
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (end < start) end = start;

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", String(chunkSize));

    const stream = b.openDownloadStream(_id, { start, end: end + 1 }); // end is exclusive
    stream.on("error", () => { if (!res.headersSent) res.status(404); res.end(); });
    req.on("aborted", () => stream.destroy());
    await pipeline(stream, res);
    return;
  }

  // No range: send whole file
  res.setHeader("Content-Length", String(total));
  const stream = b.openDownloadStream(_id);
  stream.on("error", () => { if (!res.headersSent) res.status(404); res.end(); });
  req.on("aborted", () => stream.destroy());
  await pipeline(stream, res);
};
