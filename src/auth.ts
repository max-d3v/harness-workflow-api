import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { log } from "./logging.ts";

const API_TOKEN = process.env.CODING_HARNESS_API_TOKEN_SHA256;

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
  if (!API_TOKEN) {
    log("auth", "TOKEN is not set; rejecting protected request");
    res.status(500).json({ error: "Server auth token is not configured" });
    return;
  }

  const requestToken = getRequestToken(req);
  if (!requestToken || !safeTokenEquals(requestToken, API_TOKEN)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
