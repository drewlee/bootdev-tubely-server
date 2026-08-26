import path from "node:path";
import type { BunRequest } from "bun";
import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { mediaTypeToExt, getAssetDiskPath, getAssetURL } from "./assets";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
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
  const file = formData.get("thumbnail");

  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File exceeds 10MB size limit");
  }

  const mediaType = file.type;
  if (!mediaType) {
    throw new BadRequestError("Missing Content-Type for thumbnail");
  }

  const extension = mediaTypeToExt(mediaType);
  const fileName = `${videoId}${extension}`;
  const assetPath = getAssetDiskPath(cfg, fileName);

  await Bun.write(assetPath, file);
  video.thumbnailURL = getAssetURL(cfg, fileName);

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
