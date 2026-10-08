import { QueryClient } from "@tanstack/react-query";
import { makeActivity, makeThread } from "../../test/fixtures";
import { setResolved } from "./actions";

const key = ["activity", "o", "r", 7];

function client() {
  const qc = new QueryClient();
  qc.setQueryData(key, makeActivity({ threads: [makeThread()] }));
  return qc;
}
const resolvedOf = (qc: QueryClient) => qc.getQueryData<ReturnType<typeof makeActivity>>(key)!.threads[0].isResolved;

test("resolving shows immediately", async () => {
  const qc = client();
  let finish!: () => void;
  const post = vi.fn(() => new Promise<void>((r) => { finish = r; }));

  const done = setResolved(qc, key, "T1", true, post);

  expect(resolvedOf(qc)).toBe(true);
  finish();
  await done;
  expect(post).toHaveBeenCalledWith("T1", true);
});

test("a rejected resolve is rolled back", async () => {
  const qc = client();

  await expect(setResolved(qc, key, "T1", true, vi.fn().mockRejectedValue(new Error("No permission")))).rejects.toThrow("No permission");

  expect(resolvedOf(qc)).toBe(false);
});
