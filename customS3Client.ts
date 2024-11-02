import type { S3Config } from "./util/baseTypes";
import { FakeFsS3 } from "./util/fsS3";

/**
 * To avoid circular dependency, we need a new file here.
 */
export function getClient(
  s3config: S3Config
): FakeFsS3 {
  return new FakeFsS3(s3config);
}