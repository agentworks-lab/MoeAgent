import type { LlmSettings, VoiceSettings } from '../../shared/types';

/** 依据 mime 推断上传文件名后缀（Whisper 按扩展名识别容器格式） */
function extFromMime(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('aac')) return 'mp4';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'webm';
}

export interface SttConfig {
  voice: VoiceSettings;
  llm: LlmSettings;
}

/**
 * STT 语音识别服务：Whisper API（OpenAI 兼容 /audio/transcriptions）。
 * whisperBaseUrl / whisperApiKey 留空时自动复用 LLM 的 baseUrl / apiKey，
 * 便于「同一个 OpenAI 兼容后端同时提供对话与语音识别」的常见部署。
 */
export class SttService {
  async transcribe(audioBase64: string, cfg: SttConfig, mime = 'audio/webm'): Promise<{ text: string; error?: string }> {
    const baseUrl = (cfg.voice.whisperBaseUrl || cfg.llm.baseUrl || '').trim();
    const apiKey = (cfg.voice.whisperApiKey || cfg.llm.apiKey || '').trim();
    if (!baseUrl) return { text: '', error: '未配置 STT 服务地址（voice.whisperBaseUrl 或 llm.baseUrl）' };

    try {
      const binary = Buffer.from(audioBase64, 'base64');
      if (binary.length === 0) return { text: '', error: '音频数据为空' };

      const form = new FormData();
      form.append('file', new Blob([binary]), `audio.${extFromMime(mime)}`);
      form.append('model', cfg.voice.whisperModel || 'whisper-1');
      form.append('language', 'zh');

      const url = `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { text: '', error: `Whisper 请求失败 (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}` };
      }
      const json = (await res.json()) as { text?: string };
      return { text: (json.text ?? '').trim() };
    } catch (err) {
      return { text: '', error: (err as Error).message };
    }
  }
}
