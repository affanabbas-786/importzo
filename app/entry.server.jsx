import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);

  // Embedded (and auth) HTML must never be cached. It carries hashed asset
  // references and per-session App Bridge state, so a browser (or Shopify's
  // iframe layer) holding an old copy after a deploy tries to hydrate against
  // JS chunks that no longer exist — the chunk 404s, hydration fails, and the
  // merchant sees a stale render until a manual reload fixes it. That is the
  // "flash of old pricing, then it corrected itself" seen in review. The
  // marketing pages ("/", "/privacy") are deliberately left cacheable.
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/app") || pathname.startsWith("/auth")) {
    responseHeaders.set("Cache-Control", "no-store, must-revalidate");
  }

  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
