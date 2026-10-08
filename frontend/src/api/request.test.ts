import { ApiError, onSignedOut, request } from "./request";

function reply(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

afterEach(() => vi.unstubAllGlobals());

test("returns the JSON body", async () => {
  vi.stubGlobal("fetch", reply(200, { ok: 1 }));
  expect(await request("GET", "/api/x")).toEqual({ ok: 1 });
});

test("sends JSON bodies", async () => {
  const fetch = reply(200, {});
  vi.stubGlobal("fetch", fetch);

  await request("POST", "/api/x", { a: 1 });

  const [, init] = fetch.mock.calls[0];
  expect(init.body).toBe('{"a":1}');
  expect(init.headers["Content-Type"]).toBe("application/json");
});

test("uses the server's error message", async () => {
  vi.stubGlobal("fetch", reply(400, { error: "Comment cannot be empty" }));
  await expect(request("POST", "/api/x", {})).rejects.toThrow("Comment cannot be empty");
});

test("joins validation errors", async () => {
  vi.stubGlobal("fetch", reply(422, { detail: [{ msg: "field required" }, { msg: "bad int" }] }));
  await expect(request("POST", "/api/x", {})).rejects.toThrow("field required; bad int");
});

test("announces signing out once, however many requests fail", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ error: "Please sign in", signedOut: true }), { status: 401 })));
  const listener = vi.fn();
  onSignedOut(listener);

  const first = (await request("GET", "/api/a").catch((e: unknown) => e)) as ApiError;
  await request("GET", "/api/b").catch(() => {});

  expect(first).toBeInstanceOf(ApiError);
  expect(first.signedOut).toBe(true);
  expect(listener).toHaveBeenCalledTimes(1);
});
