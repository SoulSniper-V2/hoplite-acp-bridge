// Turns an ACP client's prompt into one a cloud agent can use.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";

// Hoplite refuses requests over 1 MiB; leave room for JSON escaping and the rest of the prompt.
const MAX_REQUEST_CHARS = 900_000;
const MAX_FILES = 10;
const TEXT_TYPES = /\.(txt|md|json|jsonc|js|mjs|cjs|ts|tsx|jsx|css|html|xml|ya?ml|toml|csv|tsv|log|sh|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sql|diff|patch|ini|conf)$/i;
// T3 Code appends one of these per attachment; the path is on this machine, not in the sandbox.
const T3_ATTACHMENT = /\[Attached (\w+) "([^"\n]*)" is saved at: (\/[^\]\n]+?)(?: \(text extracted to: [^)\n]*\))?\]/g;

export function userText(text) {
  const request = /<user_request>\n?([\s\S]*?)\n?<\/user_request>\s*$/.exec(text);
  return (request ? request[1] : text).trim();
}

export function titleFrom(blocks) {
  const texts = blocks.filter((block) => block.type === "text").map((block) => block.text);
  const source = texts.find((text) => text.includes("<user_request>")) ?? texts.find((text) => !/^\s*</.test(text)) ?? "";
  const title = userText(source)
    .replace(/^\[T3 Code:[^\]]*\]\s*/, "")
    .replace(T3_ATTACHMENT, "")
    .replace(/<[^>]{1,60}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
}

const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function lastPart(uri) {
  const name = uri.split("/").pop();
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** Shrinks an image so its base64 fits; uses the tools already on the machine. */
function shrinkImage(bytes, limit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoplite-bridge-"));
  try {
    const source = path.join(dir, "in");
    const target = path.join(dir, "out.jpg");
    fs.writeFileSync(source, bytes);
    for (const size of [1600, 1200, 800, 500]) {
      try {
        if (process.platform === "darwin") {
          execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "75", "-Z", String(size), source, "--out", target], { stdio: "ignore" });
        } else {
          execFileSync("convert", [source, "-resize", `${size}x${size}>`, "-quality", "75", target], { stdio: "ignore" });
        }
      } catch {
        return undefined;
      }
      const out = fs.readFileSync(target);
      if (out.length * 1.34 <= limit) return out;
    }
    return undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Hoplite accepts text, resource links and text resources. Images and local files travel as
 * attachments: text as is, anything binary as base64 that the agent decodes in its sandbox.
 */
export function cloudPrompt(blocks, cwd) {
  const out = [];
  const files = [];
  const problems = [];
  let used = blocks.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);

  const addFile = (name, bytes, mimeType, { image = false } = {}) => {
    const safe = path.basename(name).replace(/[^\w.-]+/g, "_").slice(0, 80) || "file";
    if (files.length >= MAX_FILES) return problems.push(`${safe} (Hoplite takes at most ${MAX_FILES} files per message)`);
    let content = bytes;
    let finalName = safe;
    let budget = MAX_REQUEST_CHARS - used;
    if (image && content.length * 1.34 > budget) {
      content = shrinkImage(bytes, budget);
      if (content) finalName = `${safe.replace(/\.\w+$/, "")}.jpg`;
    }
    const isText = !image && bytes.length > 0 && !bytes.subarray(0, 8192).includes(0) && (TEXT_TYPES.test(safe) || /^text\//.test(mimeType ?? ""));
    const text = content && (isText ? content.toString("utf8") : content.toString("base64"));
    if (!text || text.length > budget) return problems.push(`${safe} (too large for Hoplite's 1 MiB request limit)`);
    used += text.length;
    let resourceName = isText ? finalName : `${finalName}.base64`;
    for (let copy = 2; files.some((file) => file.resourceName === resourceName); copy++) {
      resourceName = `${copy}-${isText ? finalName : `${finalName}.base64`}`;
    }
    files.push({ resourceName, finalName, image, encoded: !isText });
    out.push({ type: "resource", resource: { uri: `file:///${encodeURIComponent(resourceName)}`, mimeType: "text/plain", text } });
  };

  const readAttachment = (file) => {
    // The marker is plain text that a paste could contain, so it must not reach other files.
    const real = fs.realpathSync(file);
    if (path.basename(path.dirname(real)) !== "attachments" && !real.includes("/userdata/attachments/")) throw new Error("not an attachment");
    return readLocal(real);
  };
  const readLocal = (file) => {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    if (stat.size > 50 * 1024 * 1024) throw new Error("too large");
    return fs.readFileSync(file);
  };

  const imageCount = blocks.filter((block) => block.type === "image").length;
  let images = 0;
  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        const text = block.text.replace(T3_ATTACHMENT, (whole, kind, name, file) => {
          // Images also arrive as image blocks, so only their unreachable path is dropped.
          if (kind === "image" && imageCount > 0) return `[Attached image "${name}"]`;
          try {
            addFile(name, readAttachment(file), undefined, { image: kind === "image" });
            return `[Attached ${kind} "${name}"]`;
          } catch {
            problems.push(`${name} (could not be read on this computer)`);
            return `[Attached ${kind} "${name}" could not be read]`;
          }
        });
        if (text) out.push({ ...block, text });
        break;
      }
      case "image":
        images += 1;
        addFile(
          block.uri ? lastPart(block.uri) : `image-${images}.${extension[block.mimeType] ?? "png"}`,
          Buffer.from(block.data, "base64"),
          block.mimeType,
          { image: true },
        );
        break;
      case "resource":
        if (typeof block.resource?.text === "string") {
          if (block.resource.text.length === 0) break;
          used += block.resource.text.length;
          files.push({ resourceName: block.resource.uri });
          out.push(block);
        } else if (typeof block.resource?.blob === "string") {
          addFile(lastPart(block.resource.uri ?? "file"), Buffer.from(block.resource.blob, "base64"), block.resource.mimeType, {
            image: /^image\//.test(block.resource.mimeType ?? ""),
          });
        }
        break;
      case "audio":
        problems.push("an audio clip (Hoplite takes no audio)");
        break;
      case "resource_link":
        if (block.uri?.startsWith("file://")) {
          const file = decodeURIComponent(new URL(block.uri).pathname);
          const relative = path.relative(cwd, file);
          // A file inside the repository is in the sandbox too, so its path is enough.
          if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
            out.push({ type: "text", text: `@${relative}` });
            break;
          }
          try {
            addFile(block.name ?? path.basename(file), readLocal(file), block.mimeType, { image: /^image\//.test(block.mimeType ?? "") });
          } catch {
            problems.push(`${block.name ?? file} (could not be read on this computer)`);
          }
          break;
        }
        out.push(block);
        break;
      default:
        out.push(block);
    }
  }

  const encoded = files.filter((file) => file.encoded);
  const notes = [];
  if (encoded.length > 0) {
    notes.push(
      "Some attached files are base64 text because they are binary. They are listed with your attachments. Before answering, decode each one and open the result (images: view them with your file-reading tool):\n" +
        encoded.map((file) => `- ${file.resourceName}: base64 -d < <attachment path> > /tmp/${file.finalName}`).join("\n"),
    );
  }
  if (problems.length > 0) notes.push(`These could not be attached; tell the user: ${problems.join("; ")}.`);
  if (notes.length > 0) out.push({ type: "text", text: `<attachment_notes>\n${notes.join("\n\n")}\n</attachment_notes>` });
  return { blocks: out, problems };
}
