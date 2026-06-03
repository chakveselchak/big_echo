export type BrainUploadErrorCode =
  | "unauthorized"
  | "forbidden"
  | "payload_too_large"
  | "unsupported_media_type"
  | "server_error"
  | "http_error"
  | "network_error"
  | "io_error"
  | "invalid_url"
  | "token_missing"
  | "already_running"
  | "api_error"
  | "configuration_error"
  | "unknown";

export type BrainUploadPublicError = {
  code: BrainUploadErrorCode;
  message: string;
};

export function isBrainUploadPublicError(value: unknown): value is BrainUploadPublicError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BrainUploadPublicError>;
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

export function parseBrainUploadPublicError(value: unknown): BrainUploadPublicError | null {
  if (isBrainUploadPublicError(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isBrainUploadPublicError(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function formatBrainUploadUserMessage(value: unknown): string {
  const parsed = parseBrainUploadPublicError(value);
  if (parsed) {
    return parsed.message;
  }
  if (value instanceof Error) {
    const fromMessage = parseBrainUploadPublicError(value.message);
    if (fromMessage) {
      return fromMessage.message;
    }
    return value.message;
  }
  return String(value);
}

export function isBrainUploadAlreadyRunning(value: unknown): boolean {
  const parsed = parseBrainUploadPublicError(value);
  return parsed?.code === "already_running";
}
