import { insertMention, mentionAt, rankMentions } from "./mentions";

const user = (login: string, name: string | null = null) => ({ login, name, avatarUrl: "" });

test("finds the @handle being typed before the caret", () => {
  expect(mentionAt("hi @an", 6)).toEqual({ start: 3, query: "an" });
  expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionAt("(@bob-k", 7)).toEqual({ start: 1, query: "bob-k" });
  expect(mentionAt("hi @an there", 6)).toEqual({ start: 3, query: "an" });
});

test("ignores emails, finished words and code", () => {
  expect(mentionAt("me@example", 10)).toBeNull();
  expect(mentionAt("hi @ann ", 8)).toBeNull();
  expect(mentionAt("`@decorator", 11)).toBeNull();
  expect(mentionAt("no mention", 10)).toBeNull();
});

test("inserts the login and a space, keeping the rest of the text", () => {
  expect(insertMention("hi @an", 3, 6, "ann")).toEqual({ text: "hi @ann ", caret: 8 });
  expect(insertMention("hi @an there", 3, 6, "ann")).toEqual({ text: "hi @ann there", caret: 8 });
});

test("ranks the PR's people first, matching login or name, without repeats", () => {
  const participants = [user("ann", "Ann Lee"), user("zed", "Bob Zed"), user("carl")];
  const others = [user("bobby"), user("ann"), user("bob")];

  expect(rankMentions(participants, others, "b").map((u) => u.login)).toEqual(["zed", "bobby", "ann", "bob"]);
  expect(rankMentions(participants, [], "").map((u) => u.login)).toEqual(["ann", "zed", "carl"]);
  expect(rankMentions(participants, others, "", 2)).toHaveLength(2);
});

test("fills in a participant's name from the repo search", () => {
  expect(rankMentions([user("ann")], [user("ann", "Ann Lee")], "a")).toEqual([user("ann", "Ann Lee")]);
});
