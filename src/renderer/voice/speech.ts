/**
 * 语音输入（STT）渲染层封装。
 * 优先使用浏览器 Web Speech API（离线/免配置），
 * Electron 下录音也可上传 Whisper API（见 bridge.transcribe）。
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
};

export class SpeechRecognizer {
  private recognition: SpeechRecognitionLike | null = null;
  private active = false;

  static supported(): boolean {
    const w = window as unknown as Record<string, unknown>;
    return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
  }

  /** 开始监听，返回取消函数 */
  start(onResult: (text: string, isFinal: boolean) => void, onEnd: () => void): boolean {
    if (this.active) return false;
    const w = window as unknown as Record<string, new () => SpeechRecognitionLike>;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return false;

    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        const text = r[0].transcript;
        if (r.isFinal) final += text;
        else interim += text;
      }
      if (final) onResult(final, true);
      else if (interim) onResult(interim, false);
    };
    rec.onend = () => {
      this.active = false;
      onEnd();
    };
    rec.onerror = () => {
      this.active = false;
    };
    this.recognition = rec;
    this.active = true;
    try {
      rec.start();
      return true;
    } catch {
      this.active = false;
      return false;
    }
  }

  stop(): void {
    this.recognition?.stop();
    this.active = false;
  }
}

/**
 * 简易唤醒词检测：在持续识别结果中匹配唤醒词。
 * 生产环境可替换为本地唤醒模型（如 Porcupine）。
 */
export class WakeWordDetector {
  private recognizer = new SpeechRecognizer();
  private running = false;

  start(wakeWord: string, onWake: () => void): void {
    if (this.running || !SpeechRecognizer.supported()) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      const ok = this.recognizer.start(
        (text, isFinal) => {
          if (isFinal && text.replace(/\s/g, '').toLowerCase().includes(wakeWord.toLowerCase())) {
            this.stop();
            onWake();
          }
        },
        () => {
          // 识别结束后稍作停顿再继续监听，降低功耗
          if (this.running) setTimeout(loop, 500);
        }
      );
      if (!ok) this.running = false;
    };
    loop();
  }

  stop(): void {
    this.running = false;
    this.recognizer.stop();
  }
}
