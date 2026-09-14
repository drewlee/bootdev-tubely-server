import type { BunRequest } from "bun";
import { rmSync } from "node:fs";
import path from "node:path";
import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { uploadVideoToS3 } from "../s3";

export async function getVideoAspectRatio(filePath: string): Promise<string> {
  const proc = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filePath,
  ], {
    stdout: "pipe", 
    stderr: "pipe",
  });

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${stderrText}`);
  }

  const json = JSON.parse(stdoutText);
  if (!json.streams || json.streams.length === 0) {
    throw new Error("No video streams found");
  }

  const { width, height } = json.streams[0];

  if (width > height) {
    return "landscape";
  } else if (width < height) {
    return "portrait";
  }

  return "other";
}

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video resource not found");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to modify resource");
  }

  const formData = await req.formData();
  const file = formData.get("video");

  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File exceeds 1 GB size limit");
  }

  if (file.type !== "video/mp4") {
    throw new BadRequestError("Invalid media type");
  }

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, file);

  const aspectRatio = await getVideoAspectRatio(tempFilePath);
  const key = `${aspectRatio}/${videoId}.mp4`;

  await uploadVideoToS3(cfg, key, tempFilePath, "video/mp4");

  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  video.videoURL = videoURL;
  updateVideo(cfg.db, video);

  rmSync(tempFilePath, { force: true });

  return respondWithJSON(200, video);
}
