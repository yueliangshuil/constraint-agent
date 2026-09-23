import { ChatOpenAI } from "@langchain/openai";
import { getEnv } from "./env";

/** DeepSeek 对话模型（OpenAI 兼容协议），单例缓存 */
let chatModel: ChatOpenAI | null = null;

export function getChatModel(): ChatOpenAI {
  if (!chatModel) {
    chatModel = new ChatOpenAI({
      model: getEnv("CHAT_MODEL"),
      apiKey: getEnv("DEEPSEEK_API_KEY"),
      configuration: { baseURL: "https://api.deepseek.com" },
      temperature: 0.2, // 编排场景：低温度提升规划稳定性
      timeout: 60_000,
    });
  }
  return chatModel;
}
