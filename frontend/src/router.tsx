import { createBrowserRouter } from "react-router";
import { IndexPage } from "./pages/index/IndexPage";
import { ReviewPage } from "./pages/review/ReviewPage";

export const router = createBrowserRouter([
  { path: "/", element: <IndexPage /> },
  { path: "/pr/:owner/:repo/:number", element: <ReviewPage /> },
]);
