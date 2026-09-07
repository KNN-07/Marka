// Shared by the sanitized rendering pipeline and the host message boundary.
export function safeExternalUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    new TextEncoder().encode(value).length > 8192 ||
    !/^https?:\/\//i.test(value) ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f\\]/.test(value) ||
    !value.slice(value.indexOf(":") + 3).split(/[/?#]/, 1)[0] ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value) ||
    value
      .slice(value.indexOf(":") + 3)
      .split(/[/?#]/, 1)[0]
      .includes("@")
  )
    return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    return url.href.length <= 8192 ? url.href : null;
  } catch {
    return null;
  }
}
