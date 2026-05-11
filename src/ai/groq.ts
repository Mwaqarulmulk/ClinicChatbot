import Groq from "groq-sdk";
import { config } from "../config";

export const groq = config.GROQ_API_KEY ? new Groq({ apiKey: config.GROQ_API_KEY }) : null;

export type ToolCallRequest = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

