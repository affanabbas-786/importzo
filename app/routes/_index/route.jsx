import { redirect } from "react-router";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // Non-Shopify requests to / are handled by nginx (public/landing.html).
  // This branch is only reached if nginx is bypassed (e.g. direct localhost access).
  throw redirect("https://importzo.dazzletech.co");
};

export default function Index() {
  return null;
}
