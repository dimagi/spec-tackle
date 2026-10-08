import { createBrowserRouter } from "react-router";
import { IndexPage } from "./pages/index/IndexPage";
import { ReviewPage } from "./pages/review/ReviewPage";

// Served under /next while the new UI is checked against the old one.
export const BASENAME = "/next";

export const router = createBrowserRouter(
  [
    { path: "/", element: <IndexPage /> },
    { path: "/pr/:owner/:repo/:number", element: <ReviewPage /> },
  ],
  { basename: BASENAME },
);
