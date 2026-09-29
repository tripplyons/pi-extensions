import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

function invalidImage(image: ImageContent) {
  if (!/^image\/[a-z0-9.+-]+$/i.test(image.mimeType)) return "invalid image MIME type";
  const data = image.data;
  if (!data || /[^A-Za-z0-9+/=]/.test(data) ||
    Buffer.from(data, "base64").toString("base64") !== data) return "invalid base64 data";
}

// Return nothing for valid output so other tool-result metadata stays untouched.
export function sanitizeToolImages(content: (TextContent | ImageContent)[]) {
  let changed = false;
  const safe = content.map(block => {
    if (block.type !== "image") return block;
    const reason = invalidImage(block);
    if (!reason) return block;
    changed = true;
    return { type: "text" as const, text: `[Image omitted: ${reason}. Save the image to a file and use read; do not pass combined Bash stdout/stderr to image().]` };
  });
  return changed ? safe : undefined;
}
