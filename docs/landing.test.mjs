import assert from "node:assert/strict";
import test from "node:test";
import { landingNote, linkedAccount } from "./landing.mjs";

test("landing notes do not echo codes, tokens, or health fields", () => {
  const params = new URLSearchParams({
    waitlist: "1",
    code: "oauth-code-do-not-show",
    access_token: "access-do-not-show",
    refresh_token: "refresh-do-not-show",
  });
  const note = landingNote(params);
  assert.match(note.text, /whoop-lens@outlook.com/);
  assert.equal(note.text.includes("oauth-code-do-not-show"), false);
  assert.equal(note.text.includes("access-do-not-show"), false);
  assert.equal(note.text.includes("refresh-do-not-show"), false);
});

test("a caret in the email domain still identifies the linked account", () => {
  assert.equal(linkedAccount("a@b^c.com"), "a@b^c.com");
  const note = landingNote(new URLSearchParams({ connected: "1", linked_email: "a@b^c.com" }));
  assert.match(note.text, /a@b\^c\.com/);
  assert.equal(landingNote(new URLSearchParams({ connected: "1", linked_email: "not an email" })).text.includes("not an email"), false);
});

test("seat and disabled returns are fixed messages", () => {
  assert.match(landingNote(new URLSearchParams({ disabled: "1" })).text, /disabled/);
  assert.match(landingNote(new URLSearchParams({ seat: "developer_unavailable" })).text, /developer seat is already assigned/);
  assert.equal(landingNote(new URLSearchParams({ connected: "0" })), null);
});
