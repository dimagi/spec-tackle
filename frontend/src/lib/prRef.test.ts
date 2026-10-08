import { parsePrRef, prPath, samePr } from "./prRef";

test.each([
  ["https://github.com/acme/specs/pull/12", "acme", "specs"],
  ["https://github.com/acme/specs/pull/12/files", "acme", "specs"],
  ["https://github.com/acme/specs/pull/12/changes", "acme", "specs"],
  ["https://github.com/acme/specs/pull/12#discussion_r99", "acme", "specs"],
  ["https://github.com/acme/specs/pull/12?w=1", "acme", "specs"],
  ["  github.com/my.org/spec-tackle/pull/12  ", "my.org", "spec-tackle"],
  ["acme/specs#12", "acme", "specs"],
])("parses %s", (text, owner, repo) => {
  expect(parsePrRef(text)).toEqual({ owner, repo, number: 12 });
});

test.each(["", "retry", "#12", "acme/specs", "https://github.com/acme/specs/issues/12", "acme/specs#x"])(
  "rejects %j", (text) => {
    expect(parsePrRef(text)).toBeNull();
  },
);

test("prPath and samePr", () => {
  expect(prPath({ owner: "o", repo: "r", number: 7 })).toBe("/pr/o/r/7");
  expect(samePr({ owner: "o", repo: "r", number: 7 }, { owner: "o", repo: "r", number: 7 })).toBe(true);
  expect(samePr({ owner: "o", repo: "r", number: 7 }, { owner: "o", repo: "r", number: 8 })).toBe(false);
});
