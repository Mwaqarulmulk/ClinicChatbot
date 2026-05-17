import Groq from "groq-sdk";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "groq-sdk/resources/chat/completions";
import { config } from "../config";

export const groq =
  config.NODE_ENV !== "test" && config.GROQ_API_KEY
    ? new Groq({ apiKey: config.GROQ_API_KEY })
    : null;

export type ToolCallRequest = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type GroqMessage = ChatCompletionMessageParam;
export type GroqTool = ChatCompletionTool;
