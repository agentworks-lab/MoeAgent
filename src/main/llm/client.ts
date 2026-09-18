import OpenAI from 'openai';
import type { ChatMessage, LlmSettings, StreamEvent } from '../../shared/types';
import { DemoClient, extractEmotions } from '../../shared/demo';

export type StreamCallback = (event: StreamEvent) => void;

export { extractEmotions, stripEmotionTags } from '../../shared/demo';

/**
 * 把内部 ChatMessage 转为 OpenAI 兼容 API 格式。
 * 带图片的用户消息转为多模态 content 数组（text + image_url data URL），
 * 其余消息保持纯文本 content。
 */
export function toApiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.images && m.images.length > 0) {
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content },
          ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

export interface ToolCallInfo {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * OpenAI 兼容 API 客户端（适配器模式）。
 * 基于官方 openai SDK，兼容 OpenAI / DeepSeek / Ollama / vLLM 等后端，
 * 支持 SSE 流式输出与 Function Calling（tool_calls）捕获。
 */
export class OpenAiClient {
  constructor(private settings: LlmSettings) {}

  private makeClient(): OpenAI {
    return new OpenAI({
      apiKey: this.settings.apiKey || 'sk-placeholder',
      baseURL: this.settings.baseUrl,
      // 主进程场景下允许浏览器式调用（本地 Electron）
      dangerouslyAllowBrowser: true,
    });
  }

  /** 纯文本流式对话 */
  async chatStream(messages: ChatMessage[], onEvent: StreamCallback, signal?: AbortSignal): Promise<void> {
    const { text } = await this.chatStreamWithTools(messages, [], onEvent, signal);
    void text;
  }

  /**
   * 流式对话并捕获 tool_calls。
   * 返回累积的文本与工具调用列表（供上层执行工具后再次请求）。
   */
  async chatStreamWithTools(
    messages: ChatMessage[],
    tools: ToolDef[],
    onEvent: StreamCallback,
    signal?: AbortSignal
  ): Promise<{ text: string; toolCalls: ToolCallInfo[] }> {
    const s = this.settings;
    const client = this.makeClient();

    const params: Record<string, unknown> = {
      model: s.model,
      messages: toApiMessages(messages),
      temperature: s.temperature,
      top_p: s.topP,
      max_tokens: s.maxTokens,
      stream: true,
    };
    if (tools.length > 0) {
      params.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const stream = await client.chat.completions.create(params as never, { signal });

    let text = '';
    const toolCalls = new Map<number, { name: string; argText: string }>();
    const seenEmotions = new Set<string>();

    const flushEmotions = (windowText: string) => {
      for (const e of extractEmotions(windowText)) {
        if (!seenEmotions.has(e)) {
          seenEmotions.add(e);
          onEvent({ type: 'emotion', data: e });
        }
      }
    };

    for await (const chunk of stream as unknown as AsyncIterable<Record<string, any>>) {
      const delta = chunk.choices?.[0]?.delta;
      const token: string = delta?.content ?? '';
      if (token) {
        text += token;
        flushEmotions(text.slice(-64));
        onEvent({ type: 'token', data: token });
      }
      for (const tc of delta?.tool_calls ?? []) {
        const idx: number = tc.index ?? 0;
        const cur = toolCalls.get(idx) ?? { name: '', argText: '' };
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.argText += tc.function.arguments;
        toolCalls.set(idx, cur);
      }
    }

    flushEmotions(text);
    const parsedCalls = [...toolCalls.values()].map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.argText || '{}');
      } catch {
        /* ignore */
      }
      return { name: tc.name, arguments: args };
    });

    if (parsedCalls.length === 0) onEvent({ type: 'done', data: text });
    return { text, toolCalls: parsedCalls };
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const client = this.makeClient();
      await client.chat.completions.create({
        model: this.settings.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
      });
      return { ok: true, message: '连接成功' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

export interface LlmClientLike {
  chatStream(messages: ChatMessage[], onEvent: StreamCallback, signal?: AbortSignal): Promise<void>;
  test(): Promise<{ ok: boolean; message: string }>;
}

export function createClient(settings: LlmSettings): LlmClientLike {
  return settings.provider === 'demo' ? new DemoClient() : new OpenAiClient(settings);
}
