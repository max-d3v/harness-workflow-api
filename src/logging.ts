import { show_model_actions } from "./config.ts";

export function log(scope: string, message: string, err?: unknown): void {
  if (err) {
    console.error(`[${scope}] ${message}`, err);
    return;
  }
  console.log(`[${scope}] ${message}`);
}

export function logModel(
  logLabel: string | undefined,
  provider: string,
  summary: string | undefined,
): void {
  if (!show_model_actions || !summary) return;
  console.log(`[${logLabel ?? provider}] ${provider}: ${summary}`);
}
