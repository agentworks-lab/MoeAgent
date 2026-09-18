import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LlmSettings, VoiceSettings } from '../../shared/types';

export interface TtsConfig {
  voice: VoiceSettings;
  llm: LlmSettings;
}

export interface TtsResult {
  audioBase64: string;
  mime: string;
}

/**
 * TTS 语音合成服务，支持两种后端引擎：
 *  - openai：OpenAI 兼容 `POST {baseUrl}/audio/speech`（gpt-4o-mini-tts / tts-1 等）
 *  - edge  ：Edge TTS（免费高质量中文语音，经 WebSocket 直连微软服务）
 * 合成结果以 base64 返回，渲染进程播放并用 Web Audio 分析波形驱动口型同步。
 */
export class TtsService {
  private edge: any = null;
  private edgeVoice = '';
  private tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-tts-'));

  async synthesize(text: string, cfg: TtsConfig, engine?: string): Promise<TtsResult | null> {
    const clean = text.trim();
    if (!clean) return null;
    const use = engine ?? cfg.voice.ttsEngine;
    if (use === 'openai') return this.synthesizeOpenAi(clean, cfg);
    if (use === 'edge') return this.synthesizeEdge(clean, cfg);
    return null; // browser 引擎在渲染进程用 speechSynthesis 实现
  }

  /** OpenAI 兼容 TTS：POST {baseUrl}/audio/speech */
  private async synthesizeOpenAi(text: string, cfg: TtsConfig): Promise<TtsResult | null> {
    const baseUrl = (cfg.voice.openaiTtsBaseUrl || cfg.llm.baseUrl || '').trim();
    const apiKey = (cfg.voice.openaiTtsApiKey || cfg.llm.apiKey || '').trim();
    if (!baseUrl) {
      console.error('[tts] 未配置 OpenAI TTS 地址（voice.openaiTtsBaseUrl 或 llm.baseUrl）');
      return null;
    }
    try {
      const url = `${baseUrl.replace(/\/+$/, '')}/audio/speech`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.voice.openaiTtsModel || 'gpt-4o-mini-tts',
          voice: cfg.voice.openaiTtsVoice || 'alloy',
          input: text,
          response_format: 'mp3',
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[tts] OpenAI TTS 失败 (HTTP ${res.status}): ${body.slice(0, 200)}`);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) return null;
      const mime = res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg';
      return { audioBase64: buf.toString('base64'), mime };
    } catch (err) {
      console.error('[tts] OpenAI TTS 异常:', err);
      return null;
    }
  }

  /** Edge TTS（免费中文语音） */
  private async synthesizeEdge(text: string, cfg: TtsConfig): Promise<TtsResult | null> {
    try {
      const voice = cfg.voice.edgeVoice || 'zh-CN-XiaoxiaoNeural';
      if (!this.edge) {
        const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
        this.edge = new MsEdgeTTS();
        await this.edge.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        this.edgeVoice = voice;
      } else if (this.edgeVoice !== voice) {
        const { OUTPUT_FORMAT } = await import('msedge-tts');
        await this.edge.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        this.edgeVoice = voice;
      }
      const { audioFilePath } = await this.edge.toFile(this.tmpDir, text);
      const buf = fs.readFileSync(audioFilePath);
      fs.rmSync(audioFilePath, { force: true });
      return { audioBase64: buf.toString('base64'), mime: 'audio/mpeg' };
    } catch (err) {
      console.error('[tts] Edge TTS 合成失败:', err);
      return null;
    }
  }

  dispose(): void {
    try {
      this.edge?.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
  }
}
