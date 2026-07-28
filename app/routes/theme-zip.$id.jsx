import { readThemeZip } from "../lib/theme-zip.server";

export const loader = async ({ request, params }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  const zipBuffer = await readThemeZip(params.id, token);

  if (!zipBuffer) {
    return new Response("Not Found", { status: 404 });
  }

  return new Response(zipBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zipBuffer.length),
      "Cache-Control": "private, max-age=600",
      "Content-Disposition": `attachment; filename="importzo-theme-${params.id}.zip"`,
    },
  });
};
