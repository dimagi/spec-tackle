import { useLayoutEffect } from "react";
import { createBrowserRouter, useParams } from "react-router";
import { IndexPage } from "./pages/index/IndexPage";
import { ReviewPage } from "./pages/review/ReviewPage";

/** Each PR gets a fresh review page: its store, seen-state and polling are per PR. */
export function ReviewRoute() {
  const { owner, repo, number } = useParams();
  const key = `${owner}/${repo}/${number}`;
  // Braces matter: newer Chrome's scrollTo returns a promise, which React would take for a cleanup.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [key]);
  return <ReviewPage key={key} />;
}

export const router = createBrowserRouter([
  { path: "/", element: <IndexPage /> },
  { path: "/pr/:owner/:repo/:number", element: <ReviewRoute /> },
]);
