/**
 * 共享模块：情感标签解析 + 内置演示 LLM。
 * 纯 TypeScript 实现，主进程与浏览器开发模式均可使用。
 */
import type { ChatMessage, StreamEvent } from './types';

const EMOTION_RE = /\[emotion:\s*([a-zA-Z_]+)\s*\]/g;

/** 已知情感名：用于兼容部分后端直接输出的裸标签 `[happy]`（而非 `[emotion:happy]`） */
const KNOWN_EMOTIONS = ['happy', 'shy', 'sad', 'thinking', 'angry', 'surprised', 'embarrassed', 'neutral'];
const BARE_EMOTION_RE = new RegExp(`\\[\\s*(${KNOWN_EMOTIONS.join('|')})\\s*\\]`, 'gi');

/** 从文本中提取所有情感标签（兼容 [emotion:xxx] 与裸 [xxx] 两种格式） */
export function extractEmotions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EMOTION_RE)) out.push(m[1].toLowerCase());
  for (const m of text.matchAll(BARE_EMOTION_RE)) out.push(m[1].toLowerCase());
  return out;
}

/** 去除文本中的情感标签，得到纯文本（两种格式都剥离） */
export function stripEmotionTags(text: string): string {
  return text.replace(EMOTION_RE, '').replace(BARE_EMOTION_RE, '').trim();
}

/** 演示模式回复池：无 API Key 时也能完整体验 文本→情感→表情 闭环 */
const DEMO_REPLIES: { keywords: string[]; emotion: string; text: string }[] = [
  {
    keywords: ['你好', '嗨', 'hi', 'hello', '在吗'],
    emotion: 'happy',
    text: '你好呀！我是 Mao，你的桌面小猫助手～今天想聊点什么，或者需要我帮你做什么吗？',
  },
  {
    keywords: ['名字', '你是谁', '介绍'],
    emotion: 'happy',
    text: '我叫 Mao，是一只住在桌面上的小猫！我会根据你的话变换表情和动作，还能陪你聊天解闷～',
  },
  {
    keywords: ['天气'],
    emotion: 'thinking',
    text: '嗯……我现在还看不到窗外的天气呢。你可以在设置里接入 LLM 服务，我就能调用天气工具啦！',
  },
  {
    keywords: ['难过', '伤心', '不开心', '累', '烦'],
    emotion: 'sad',
    text: '呜……看到你难过我也好心疼。要不要休息一下？我会一直在这里陪着你的，摸摸头～',
  },
  {
    keywords: ['生气', '讨厌', '气死'],
    emotion: 'angry',
    text: '哼！谁惹你生气了？告诉我，我帮你瞪他！……不过深呼吸一下，别气坏了身体哦。',
  },
  {
    keywords: ['厉害', '棒', '谢谢', '感谢', '赞'],
    emotion: 'shy',
    text: '诶嘿嘿……被你这么夸，人家都有点不好意思了啦～能帮到你我就很开心！',
  },
  {
    keywords: ['时间', '几点'],
    emotion: 'neutral',
    text: `现在是 ${new Date().toLocaleTimeString('zh-CN')} 哦。时间过得真快，记得劳逸结合呀～`,
  },
  {
    keywords: ['笑话', '搞笑', '开心'],
    emotion: 'happy',
    text: '来一个！为什么程序员总是分不清万圣节和圣诞节？——因为 Oct 31 == Dec 25（八进制的31等于十进制的25）！喵哈哈～',
  },
  {
    keywords: ['跳', '挥手', '动一下', '动作'],
    emotion: 'surprised',
    text: '好嘞，看我给你表演一个！嘿嘿～是不是很有活力？',
  },
];

const DEMO_FALLBACKS: { emotion: string; text: string }[] = [
  {
    emotion: 'thinking',
    text: '嗯嗯，我认真听着呢！不过我目前运行在演示模式，想让我更聪明地回答，可以在设置里配置 OpenAI 兼容的 API 哦～',
  },
  {
    emotion: 'happy',
    text: '喵～你说的好有意思！虽然演示模式下我懂的还不多，但接入真正的 LLM 后我就能畅所欲言啦！',
  },
  {
    emotion: 'surprised',
    text: '哇，这个问题好深奥！演示模式的小脑袋有点转不过来了……快在设置里给我接上 LLM 大脑吧！',
  },
];

export type DemoStreamCallback = (event: StreamEvent) => void;

/**
 * 内置演示 LLM：无需网络即可模拟流式输出与情感标签，
 * 用于开箱即用的完整体验闭环。
 */
export class DemoClient {
  private fallbackIdx = 0;

  async chatStream(messages: ChatMessage[], onEvent: DemoStreamCallback, signal?: AbortSignal): Promise<void> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const lower = lastUser.toLowerCase();

    const reply = DEMO_REPLIES.find((r) => r.keywords.some((k) => lower.includes(k.toLowerCase())));
    let emotion: string;
    let text: string;
    if (reply) {
      emotion = reply.emotion;
      text = reply.text;
    } else {
      const fb = DEMO_FALLBACKS[this.fallbackIdx++ % DEMO_FALLBACKS.length];
      emotion = fb.emotion;
      text = fb.text;
    }

    await sleep(400, signal);
    onEvent({ type: 'emotion', data: emotion });

    const full = `[emotion:${emotion}] ${text}`;
    for (const ch of text) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      onEvent({ type: 'token', data: ch });
      await sleep(28 + Math.random() * 30, signal);
    }
    onEvent({ type: 'done', data: full });
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: '演示模式始终可用' };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}
