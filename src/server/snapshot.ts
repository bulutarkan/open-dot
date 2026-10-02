import "server-only";
import * as repo from "./repo";
import { dockerAvailable, BOX_IMAGE } from "./computer/shell";
import { defaultMode } from "./computer";
import { knownModels, hasKey, keySource } from "./agent/client";
import { chatGPTStatus } from "./agent/chatgpt";
import { COMPUTER_ENABLED } from "./agent/tools";
import { skyInstalled } from "./computer/sky";
import { cloudKeySource } from "./computer/cloud";
import { openRouterSource } from "./agent/openrouter";
import { openCodeProducts, openCodeSource } from "./agent/opencode";
import { triggersKeySource } from "./triggers";
import { apps, signedIn } from "./composio";
import type { ComputerInfo, Snapshot } from "@/lib/types";
import { readUserProfile } from "./user-profile";

export function computerInfo(): ComputerInfo {
  const m = knownModels();
  const products = openCodeProducts();
  return {
    mode: defaultMode(),
    docker: dockerAvailable(),
    image: BOX_IMAGE,
    model: m.defaultModel,
    models: m.available,
    computerTool: COMPUTER_ENABLED ? "computer" : "off",
    hasKey: hasKey(),
    keySource: keySource(),
    chatgpt: chatGPTStatus(),
    cloudKey: cloudKeySource(),
    openRouter: openRouterSource(),
    openCode: {
      go: { source: openCodeSource("go"), enabled: products.go },
      zen: { source: openCodeSource("zen"), enabled: products.zen },
    },
    triggersKey: triggersKeySource(),
    sky: skyInstalled(),
    composio: signedIn(),
  };
}

export function snapshot(): Snapshot {
  return {
    userProfile: readUserProfile(),
    dots: repo.listDots(),
    messages: [...repo.recentMessages(120), ...repo.channelMessages(300)],
    routines: repo.listRoutines(),
    triggers: repo.listTriggers(),
    rules: repo.listRules(),
    memories: repo.listMemories(),
    skills: repo.listSkills(),
    passwords: repo.listPasswords(),
    computer: computerInfo(),
    apps: apps(),
    channels: repo.listChannels(),
    conversations: repo.listConversations(),
  };
}
