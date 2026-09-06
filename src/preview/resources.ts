export function safeImagePath(path: string): boolean {
  return (
    !!path &&
    !/^[\/\\]|[\\:\u0000-\u001f\u007f?#]/.test(path) &&
    !/%(?:2e|2f|5c|3a|00)/i.test(path) &&
    /\.(png|jpe?g|gif|webp)$/i.test(path)
  );
}
export function resolveImagePath(
  documentPath: string | null,
  imagePath: string,
): string {
  if (!safeImagePath(imagePath))
    throw new Error(
      "Only relative local PNG, JPEG, GIF and WebP images are supported.",
    );
  const parts = documentPath?.split("/").slice(0, -1) ?? [];
  for (const part of imagePath.split("/")) {
    if (part === "..") {
      if (!parts.length) throw new Error("Image path escapes the workspace.");
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
