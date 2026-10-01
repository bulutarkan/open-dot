import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db";
import { USER_PROFILE_FILE, USER_PROFILE_MAX_CHARS } from "@/lib/user-profile";
const MAX_READ_CHARS = 20_000;

const profilePath = () => path.join(DATA_DIR, USER_PROFILE_FILE);

export function readUserProfile(): string {
  try {
    return fs.readFileSync(profilePath(), "utf8").slice(0, MAX_READ_CHARS).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export function userProfileForPrompt(): string {
  const profile = readUserProfile();
  if (profile.length <= USER_PROFILE_MAX_CHARS) return profile;
  return `${profile.slice(0, USER_PROFILE_MAX_CHARS - 54).trimEnd()}\n\n[…USER.md truncated to ${USER_PROFILE_MAX_CHARS} characters…]`;
}

export function writeUserProfile(content: string): string | null {
  const clean = content.trim();
  if (clean.length > USER_PROFILE_MAX_CHARS) return `Keep your universal profile under ${USER_PROFILE_MAX_CHARS.toLocaleString()} characters.`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = profilePath();
  if (!clean) {
    try { fs.unlinkSync(target); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    return null;
  }
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${clean}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, target);
  return null;
}
