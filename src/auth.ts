import type { NextFunction, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { log } from "./logging.ts";

const API_TOKEN_SHA256 = process.env.CODING_HARNESS_API_TOKEN_SHA256?.trim();

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeTokenEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function getRequestToken(req: Request): string | undefined {
  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return req.get("x-api-token")?.trim();
}

export function requireTokenAuth(req: Request, res: Response, next: NextFunction): void {
  if (!API_TOKEN_SHA256) {
    log("auth", "CODING_HARNESS_API_TOKEN_SHA256 is not set; rejecting protected request");
    res.status(500).json({ error: "Server auth token is not configured" });
    return;
  }

  const requestToken = getRequestToken(req);
  if (!requestToken || !safeTokenEquals(sha256Hex(requestToken), API_TOKEN_SHA256)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
