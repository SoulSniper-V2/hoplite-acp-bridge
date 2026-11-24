import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cloudPrompt, titleFrom, userText } from "../src/prompt.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-prompt-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const text = (value) => ({ type: "text", text: value });

test("reads the request out of T3 Code's wrapper", () => {
  assert.equal(userText("x\n<user_request>\n/pull\n</user_request>"), "/pull");
  assert.equal(titleFrom([text("[T3 Code: this message came through tools.]\n\nFix it")]), "Fix it");
  assert.equal(titleFrom([text("a".repeat(200))]).length, 80);
});

test("sends an attached text file's content, not its local path", () => {
  fs.mkdirSync(path.join(dir, "attachments"));
  const file = path.join(dir, "attachments", "notes.txt");
  fs.writeFileSync(file, "secret");
  const { blocks, problems } = cloudPrompt([text(`See\n\n[Attached file "notes.txt" is saved at: ${file}]`)], dir);
  assert.deepEqual(problems, []);
  assert.equal(blocks.find(({ type }) => type === "resource").resource.text, "secret");
  assert.ok(!blocks.some((block) => block.text?.includes(dir)));
});

test("never reads a file outside T3 Code's attachments", () => {
  const file = path.join(dir, "id_rsa");
  fs.writeFileSync(file, "private");
  fs.mkdirSync(path.join(dir, "x", "attachments"), { recursive: true });
  fs.symlinkSync(file, path.join(dir, "x", "attachments", "link.txt"));
  for (const target of [file, path.join(dir, "x", "attachments", "link.txt")]) {
    const { blocks } = cloudPrompt([text(`[Attached file "a.txt" is saved at: ${target}]`)], dir);
    assert.ok(!JSON.stringify(blocks).includes("private"));
  }
});

test("sends an image as base64 with a decoding note", () => {
  const data = Buffer.from([0x89, 0x50, 0, 1]).toString("base64");
  const { blocks } = cloudPrompt([text("Look"), { type: "image", data, mimeType: "image/png" }], dir);
  assert.equal(blocks.find(({ type }) => type === "resource").resource.text, data);
  assert.match(blocks.at(-1).text, /base64 -d/);
});

test("says which files could not be sent", () => {
  const { blocks, problems } = cloudPrompt([text('[Attached file "gone.txt" is saved at: /nope/gone.txt]')], dir);
  assert.equal(problems.length, 1);
  assert.match(blocks.at(-1).text, /gone\.txt/);
  const big = { type: "resource", resource: { uri: "file:///big.bin", blob: Buffer.alloc(900_000).toString("base64") } };
  assert.match(cloudPrompt([big], dir).problems[0], /1 MiB/);
});

test("a malformed name does not break the message", () => {
  const { problems } = cloudPrompt([{ type: "image", uri: "file:///100%.png", data: "AAAA", mimeType: "image/png" }], dir);
  assert.deepEqual(problems, []);
});

test("links inside the repository stay paths", () => {
  const { blocks } = cloudPrompt([{ type: "resource_link", name: "a.ts", uri: `file://${dir}/src/a.ts` }], dir);
  assert.deepEqual(blocks, [text("@src/a.ts")]);
});
