import type { S3Config } from "./utils/baseTypes";
import { CustomS3 } from "./utils/customS3";

/**
 * To avoid circular dependency, we need a new file here.
 */
export function getClient(
  s3config: S3Config
): CustomS3 {
  return new CustomS3(s3config);
}