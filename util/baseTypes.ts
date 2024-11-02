/**
 * Only type defs here.
 * To avoid circular dependency.
 */


export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export interface S3Config {
  s3Endpoint: string;
  s3Region: string;
  s3AccessKeyID: string;
  s3SecretAccessKey: string;
  s3BucketName: string;

  partsConcurrency?: number;
  forcePathStyle?: boolean;
  remotePrefix?: string;

  useAccurateMTime?: boolean;
  reverseProxyNoSignUrl?: string;

  generateFolderObject?: boolean;

  /**
   * @deprecated
   */
  bypassCorsLocally?: boolean;
}


/**
 * uniform representation
 * everything should be flat and primitive, so that we can copy.
 */
export interface Entity {
  key?: string;
  keyEnc?: string;
  keyRaw: string;
  mtimeCli?: number;
  mtimeCliFmt?: string;
  ctimeCli?: number;
  ctimeCliFmt?: string;
  mtimeSvr?: number;
  mtimeSvrFmt?: string;
  prevSyncTime?: number;
  prevSyncTimeFmt?: string;
  size?: number; // might be unknown or to be filled
  sizeEnc?: number;
  sizeRaw: number;
  hash?: string;
  etag?: string;
  synthesizedFolder?: boolean;
  synthesizedFile?: boolean;
}

export interface UploadedType {
  entity: Entity;
  mtimeCli?: number;
}