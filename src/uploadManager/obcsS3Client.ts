import type { S3Config } from "../utils/baseTypes";
import { CustomS3 } from "./customS3";

/**
 * To avoid circular dependency, we need a new file here.
 */
export function getCustomS3Client(
  s3config: S3Config
): CustomS3 {
  return new CustomS3(s3config);
}