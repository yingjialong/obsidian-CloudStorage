import { Buffer } from "buffer";
// import * as path from "path";
// import { Readable } from "stream";
import type { PutObjectCommandInput, _Object } from "@aws-sdk/client-s3";
import {
  ListObjectsV2Command,
  type ListObjectsV2CommandInput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { HttpHandlerOptions } from "@aws-sdk/types";
import {
  FetchHttpHandler,
  type FetchHttpHandlerOptions,
} from "@smithy/fetch-http-handler";
// @ts-ignore
import { requestTimeout } from "@smithy/fetch-http-handler/dist-es/request-timeout";
import { type HttpRequest, HttpResponse } from "@smithy/protocol-http";
import { buildQueryString } from "@smithy/querystring-builder";
import { App, type RequestUrlParam, requestUrl, TFile } from "obsidian";
import { type S3Config } from "./baseTypes";
import { VALID_REQURL } from "./baseTypesObs";

import type { Entity } from "./baseTypes";
import { FileTypeUtil } from './getMimeType';

const bufferToArrayBuffer = (
  b: Buffer | Uint8Array | ArrayBufferView
) => {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

////////////////////////////////////////////////////////////////////////////////
// special handler using Obsidian requestUrl
////////////////////////////////////////////////////////////////////////////////

/**
 * This is close to origin implementation of FetchHttpHandler
 * https://github.com/aws/aws-sdk-js-v3/blob/main/packages/fetch-http-handler/src/fetch-http-handler.ts
 * that is released under Apache 2 License.
 * But this uses Obsidian requestUrl instead.
 */
class ObsHttpHandler extends FetchHttpHandler {
  
  requestTimeoutInMs: number | undefined;
  reverseProxyNoSignUrl: string | undefined;
  constructor(
    options?: FetchHttpHandlerOptions,
    reverseProxyNoSignUrl?: string
  ) {
    super(options);
    this.requestTimeoutInMs =
      options === undefined ? undefined : options.requestTimeout;
    this.reverseProxyNoSignUrl = reverseProxyNoSignUrl;
  }
  async handle(
    request: HttpRequest,
    { abortSignal }: HttpHandlerOptions = {}
  ): Promise<{ response: HttpResponse }> {
    if (abortSignal?.aborted) {
      const abortError = new Error("Request aborted");
      abortError.name = "AbortError";
      return Promise.reject(abortError);
    }

    let path = request.path;
    if (request.query) {
      const queryString = buildQueryString(request.query);
      if (queryString) {
        path += `?${queryString}`;
      }
    }

    const { port, method } = request;
    let url = `${request.protocol}//${request.hostname}${
      port ? `:${port}` : ""
    }${path}`;
    if (
      this.reverseProxyNoSignUrl !== undefined &&
      this.reverseProxyNoSignUrl !== ""
    ) {
      const urlObj = new URL(url);
      urlObj.host = this.reverseProxyNoSignUrl;
      url = urlObj.href;
    }
    const body =
      method === "GET" || method === "HEAD" ? undefined : request.body;

    const transformedHeaders: Record<string, string> = {};
    for (const key of Object.keys(request.headers)) {
      const keyLower = key.toLowerCase();
      if (keyLower === "host" || keyLower === "content-length") {
        continue;
      }
      transformedHeaders[keyLower] = request.headers[key];
    }

    let contentType: string | undefined = undefined;
    if (transformedHeaders["content-type"] !== undefined) {
      contentType = transformedHeaders["content-type"];
    }

    let transformedBody: any = body;
    if (ArrayBuffer.isView(body)) {
      transformedBody = bufferToArrayBuffer(body);
    }

    const param: RequestUrlParam = {
      body: transformedBody,
      headers: transformedHeaders,
      method: method,
      url: url,
      contentType: contentType,
    };

    const raceOfPromises = [
      requestUrl(param).then((rsp) => {
        const headers = rsp.headers;
        const headersLower: Record<string, string> = {};
        for (const key of Object.keys(headers)) {
          headersLower[key.toLowerCase()] = headers[key];
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(rsp.arrayBuffer));
            controller.close();
          },
        });
        return {
          response: new HttpResponse({
            headers: headersLower,
            statusCode: rsp.status,
            body: stream,
          }),
        };
      }),
      requestTimeout(this.requestTimeoutInMs),
    ];

    if (abortSignal) {
      raceOfPromises.push(
        new Promise<never>((resolve, reject) => {
          abortSignal.onabort = () => {
            const abortError = new Error("Request aborted");
            abortError.name = "AbortError";
            reject(abortError);
          };
        })
      );
    }
    return Promise.race(raceOfPromises);
  }
}

const getS3Client = (s3Config: S3Config) => {
  let endpoint = s3Config.s3Endpoint;
  if (!(endpoint.startsWith("http://") || endpoint.startsWith("https://"))) {
    endpoint = `https://${endpoint}`;
  }

  let s3Client: S3Client;
  if (VALID_REQURL) {
    s3Client = new S3Client({
      region: s3Config.s3Region,
      endpoint: endpoint,
      forcePathStyle: s3Config.forcePathStyle,
      credentials: {
        accessKeyId: s3Config.s3AccessKeyID,
        secretAccessKey: s3Config.s3SecretAccessKey,
      },
      requestHandler: new ObsHttpHandler(
        undefined,
        s3Config.reverseProxyNoSignUrl
      ),
    });
  } else {
    s3Client = new S3Client({
      region: s3Config.s3Region,
      endpoint: endpoint,
      forcePathStyle: s3Config.forcePathStyle,
      credentials: {
        accessKeyId: s3Config.s3AccessKeyID,
        secretAccessKey: s3Config.s3SecretAccessKey,
      },
    });
  }

  s3Client.middlewareStack.add(
    (next, context) => (args) => {
      (args.request as any).headers["cache-control"] = "no-cache";
      return next(args);
    },
    {
      step: "build",
    }
  );

  return s3Client;
};

export class CustomS3{
  s3Config: S3Config;
  s3Client: S3Client;
  kind: "s3";
  synthFoldersCache: Record<string, Entity>;
  constructor(s3Config: S3Config) {
    this.s3Config = s3Config;
    this.s3Client = getS3Client(s3Config);
    this.kind = "s3";
    this.synthFoldersCache = {};
  }


  async checkConnect(callbackFunc?: any): Promise<boolean> {
    try {
      // const results = await this.s3Client.send(
      //   new HeadBucketCommand({ Bucket: this.s3Config.s3BucketName })
      // );
      // very simplified version of listing objects
      const confCmd = {
        Bucket: this.s3Config.s3BucketName,
      } as ListObjectsV2CommandInput;
      const results = await this.s3Client.send(
        new ListObjectsV2Command(confCmd)
      );

      if (
        results === undefined ||
        results.$metadata === undefined ||
        results.$metadata.httpStatusCode === undefined
      ) {
        throw Error("results or $metadata or httStatusCode is undefined");
      }
      if (results.$metadata.httpStatusCode !== 200) {
        throw Error(`not 200 httpStatusCode`);
      }
    } catch (err: any) {
      return false;
    }
    console.info(`check connect: ok`);
    return true;

  }

  
  async uploadFile(file: TFile, key: string, app: App): Promise<boolean> {

    const contentType = FileTypeUtil.getMimeType(file.name);
    try {

          const fileContent = await app.vault.readBinary(file);
          const p: PutObjectCommandInput = {
            Bucket: this.s3Config.s3BucketName,
            Key: key,
            Body: new Uint8Array(fileContent),
            ContentType: contentType,
          };
          await this.s3Client.send(new PutObjectCommand(p));
          return true;

    } catch (error) {
        console.error('Error uploading to custom S3:', error);
        throw error;
    }
  }
}
