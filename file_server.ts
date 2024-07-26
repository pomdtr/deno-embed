#!/usr/bin/env -S deno run --allow-net --allow-read
// Copyright 2018-2024 the Deno authors. All rights reserved. MIT license.

// This program serves files in the current directory over HTTP.
// TODO(bartlomieju): Add tests like these:
// https://github.com/indexzero/http-server/blob/master/test/http-server-test.js

/**
 * Contains functions {@linkcode serveDir} and {@linkcode serveFile} for building a static file server.
 *
 * This module can also be used as a cli. If you want to run directly:
 *
 * ```shell
 * > # start server
 * > deno run --allow-net --allow-read @std/http/file-server
 * > # show help
 * > deno run --allow-net --allow-read @std/http/file-server --help
 * ```
 *
 * If you want to install and run:
 *
 * ```shell
 * > # install
 * > deno install --allow-net --allow-read @std/http/file-server
 * > # start server
 * > file_server
 * > # show help
 * > file_server --help
 * ```
 *
 * @module
 */

import type { Embeds, FileMeta } from "./embed.ts";
import { normalize as posixNormalize } from "jsr:/@std/path@1.0.0-rc.2/posix/normalize";
import { extname } from "jsr:/@std/path@1.0.0-rc.2/extname";
import { join } from "jsr:/@std/path@1.0.0-rc.2/join";
import { contentType } from "jsr:/@std/media-types@^1.0.0-rc.1/content-type";
import {
  ifNoneMatch,
  isRedirectStatus,
  STATUS_CODE,
  STATUS_TEXT,
  type StatusCode,
} from "jsr:@std/http@1.0.0-rc.4";

function createStandardResponse(status: StatusCode, init?: ResponseInit) {
  const statusText = STATUS_TEXT[status];
  return new Response(statusText, { status, statusText, ...init });
}

/** Interface for serveFile options. */
export interface ServeFileOptions {
  /** The algorithm to use for generating the ETag.
   *
   * @default {"SHA-256"}
   */
  etagAlgorithm?: AlgorithmIdentifier;
  /** An optional FileInfo object returned by Deno.stat. It is used for optimization purposes. */
  fileMeta?: FileMeta;
}

/**
 * Returns an HTTP Response with the requested file as the body.
 *
 * @example Usage
 * ```ts no-eval
 * import { serveFile } from "@std/http/file-server";
 *
 * Deno.serve((req) => {
 *   return serveFile(req, "README.md");
 * });
 * ```
 *
 * @param req The server request context used to cleanup the file handle.
 * @param filePath Path of the file to serve.
 * @returns A response for the request.
 */
export async function serveFile(
  embeds: Embeds,
  req: Request,
  filePath: string,
  options: ServeFileOptions = {},
): Promise<Response> {
  const fileMeta = options.fileMeta || await embeds.stat(filePath);
  if (!fileMeta) {
    await req.body?.cancel();
    return createStandardResponse(STATUS_CODE.NotFound);
  }

  const headers = createBaseHeaders();

  // Set date header if access timestamp is available
  if (fileMeta.atime) {
    headers.set("date", fileMeta.atime.toUTCString());
  }

  const etag = fileMeta.eTag;

  // Set last modified header if last modification timestamp is available
  if (fileMeta.mtime) {
    headers.set("last-modified", fileMeta.mtime.toUTCString());
  }
  if (etag) {
    headers.set("etag", etag);
  }

  if (etag || fileMeta.mtime) {
    // If a `if-none-match` header is present and the value matches the tag or
    // if a `if-modified-since` header is present and the value is bigger than
    // the access timestamp value, then return 304
    const ifNoneMatchValue = req.headers.get("if-none-match");
    const ifModifiedSinceValue = req.headers.get("if-modified-since");
    if (
      (!ifNoneMatch(ifNoneMatchValue, etag)) ||
      (ifNoneMatchValue === null &&
        fileMeta.mtime &&
        ifModifiedSinceValue &&
        fileMeta.mtime.getTime() <
          new Date(ifModifiedSinceValue).getTime() + 1000)
    ) {
      const status = STATUS_CODE.NotModified;
      return new Response(null, {
        status,
        statusText: STATUS_TEXT[status],
        headers,
      });
    }
  }

  // Set mime-type using the file extension in filePath
  const contentTypeValue = contentType(extname(filePath));
  if (contentTypeValue) {
    headers.set("content-type", contentTypeValue);
  }

  const fileSize = fileMeta.size;

  // Set content length
  headers.set("content-length", `${fileSize}`);

  const file = await embeds.get(filePath);
  if (!file) {
    await req.body?.cancel();
    return createStandardResponse(STATUS_CODE.NotFound);
  }

  const status = STATUS_CODE.OK;
  return new Response(await file.bytes(), {
    status,
    statusText: STATUS_TEXT[status],
    headers,
  });
}

function serveFallback(maybeError: unknown): Response {
  if (maybeError instanceof URIError) {
    return createStandardResponse(STATUS_CODE.BadRequest);
  }

  if (maybeError instanceof Deno.errors.NotFound) {
    return createStandardResponse(STATUS_CODE.NotFound);
  }

  return createStandardResponse(STATUS_CODE.InternalServerError);
}

function createBaseHeaders(): Headers {
  return new Headers({
    server: "deno",
    // Set "accept-ranges" so that the client knows it can make range requests on future requests
    "accept-ranges": "bytes",
  });
}

/** Interface for serveDir options. */
export interface ServeDirOptions {
  /** Serves the files under the given directory root. Defaults to your current directory.
   *
   * @default {"."}
   */
  fsRoot?: string;
  /** Specified that part is stripped from the beginning of the requested pathname.
   *
   * @default {undefined}
   */
  urlRoot?: string;
  /** Enable CORS via the "Access-Control-Allow-Origin" header.
   *
   * @default {false}
   */
  enableCors?: boolean;
  /** Headers to add to each response
   *
   * @default {{}}
   */
  headers?: HeadersInit;
}

/**
 * Serves the files under the given directory root (opts.fsRoot).
 *
 * @example Usage
 * ```ts no-eval
 * import { serveDir } from "@std/http/file-server";
 *
 * Deno.serve((req) => {
 *   const pathname = new URL(req.url).pathname;
 *   if (pathname.startsWith("/static")) {
 *     return serveDir(req, {
 *       fsRoot: "path/to/static/files/dir",
 *     });
 *   }
 *   // Do dynamic responses
 *   return new Response();
 * });
 * ```
 *
 * @example Optionally you can pass `urlRoot` option. If it's specified that part is stripped from the beginning of the requested pathname.
 *
 * ```ts no-eval
 * import { serveDir } from "@std/http/file-server";
 *
 * // ...
 * serveDir(new Request("http://localhost/static/path/to/file"), {
 *   fsRoot: "public",
 *   urlRoot: "static",
 * });
 * ```
 *
 * The above example serves `./public/path/to/file` for the request to `/static/path/to/file`.
 *
 * @param req The request to handle
 * @param opts Additional options.
 * @returns A response for the request.
 */
export async function serveDir(
  embeds: Embeds,
  req: Request,
  opts: ServeDirOptions = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await createServeDirResponse(embeds, req, opts);
  } catch (error) {
    response = serveFallback(error);
  }

  // Do not update the header if the response is a 301 redirect.
  const isRedirectResponse = isRedirectStatus(response.status);

  if (opts.enableCors && !isRedirectResponse) {
    response.headers.append("access-control-allow-origin", "*");
    response.headers.append(
      "access-control-allow-headers",
      "Origin, X-Requested-With, Content-Type, Accept, Range",
    );
  }

  if (opts.headers && !isRedirectResponse) {
    const additionalHeaders = new Headers(opts.headers);
    for (const [key, value] of additionalHeaders) {
      response.headers.append(key, value);
    }
  }

  return response;
}

async function createServeDirResponse(
  embeds: Embeds,
  req: Request,
  opts: ServeDirOptions,
) {
  const target = opts.fsRoot || ".";
  const urlRoot = opts.urlRoot;

  const url = new URL(req.url);
  const decodedUrl = decodeURIComponent(url.pathname);
  let normalizedPath = posixNormalize(decodedUrl);

  if (urlRoot && !normalizedPath.startsWith("/" + urlRoot)) {
    return createStandardResponse(STATUS_CODE.NotFound);
  }

  // Redirect paths like `/foo////bar` and `/foo/bar/////` to normalized paths.
  if (normalizedPath !== decodedUrl) {
    url.pathname = normalizedPath;
    return Response.redirect(url, 301);
  }

  if (urlRoot) {
    normalizedPath = normalizedPath.replace(urlRoot, "");
  }

  if (normalizedPath.endsWith("/")) {
    normalizedPath = normalizedPath + "index.html";
  } else if (normalizedPath === "/") {
    normalizedPath = "/index.html";
  }

  const fsPath = join(target, normalizedPath);
  const fileMeta = await embeds.stat(fsPath);
  return serveFile(embeds, req, fsPath, { fileMeta: fileMeta || undefined });
}
