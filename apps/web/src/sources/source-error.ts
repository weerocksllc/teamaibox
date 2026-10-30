export function sourceErrorKey(error: unknown) {
  return error instanceof TypeError || (error instanceof Error && "status" in error && typeof error.status === "number" && error.status >= 500)
    ? "admin.sources.unavailable" : "admin.sources.error";
}
