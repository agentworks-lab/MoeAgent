/**
 * TTS 播放与口型同步（Lip-Sync）。
 * - Edge TTS：播放主进程返回的 base64 MP3，用 Web Audio AnalyserNode
 *   实时分析波形幅度驱动 Live2D 口型参数。
 * - 浏览器引擎：使用 speechSynthesis，以随机包络近似口型。
 */
export class TtsPlayer {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId = 0;
  private currentAudio: HTMLAudioElement | null = null;
  private speaking = false;

  constructor(private onLipSync: (value: number) => void, private onStateChange: (speaking: boolean) => void) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** 播放 Edge TTS 返回的 base64 音频并驱动口型 */
  async playBase64(base64: string, mime: string): Promise<void> {
    this.stop();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);

    const audio = new Audio(url);
    this.currentAudio = audio;

    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.5;
    }
    const analyser = this.analyser!;
    const source = this.audioCtx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(this.audioCtx.destination);

    await this.audioCtx.resume();
    this.setSpeaking(true);
    this.trackLipSync();

    await new Promise<void>((resolve) => {
      audio.onended = () => {
        URL.revokeObjectURL(url);
        this.setSpeaking(false);
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        this.setSpeaking(false);
        resolve();
      };
      void audio.play();
    });
  }

  /** 使用浏览器 speechSynthesis 朗读，并以近似包络驱动口型 */
  playBrowser(text: string, lang = 'zh-CN'): Promise<void> {
    this.stop();
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) {
        resolve();
        return;
      }
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = lang;
      utter.rate = 1.05;
      utter.pitch = 1.2;
      this.setSpeaking(true);

      // 近似口型：说话期间用平滑噪声模拟开合
      let t = 0;
      const envelope = () => {
        if (!this.speaking) return;
        t += 0.18;
        const v = Math.abs(Math.sin(t * 2.1) * 0.6 + Math.sin(t * 5.3) * 0.4);
        this.onLipSync(Math.min(1, v));
        this.rafId = requestAnimationFrame(envelope);
      };
      envelope();

      utter.onend = () => {
        this.setSpeaking(false);
        resolve();
      };
      utter.onerror = () => {
        this.setSpeaking(false);
        resolve();
      };
      window.speechSynthesis.speak(utter);
    });
  }

  private trackLipSync(): void {
    if (!this.analyser) return;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const loop = () => {
      if (!this.speaking || !this.analyser) return;
      this.analyser.getByteFrequencyData(data);
      // 取人声主要频段（前 1/3）的平均幅度
      const n = Math.floor(data.length / 3);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += data[i];
      const avg = sum / n / 255;
      this.onLipSync(Math.min(1, avg * 2.2));
      this.rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  private setSpeaking(v: boolean): void {
    if (this.speaking === v) return;
    this.speaking = v;
    cancelAnimationFrame(this.rafId);
    if (!v) this.onLipSync(0);
    this.onStateChange(v);
  }

  stop(): void {
    this.setSpeaking(false);
    try {
      this.currentAudio?.pause();
    } catch {
      /* ignore */
    }
    this.currentAudio = null;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.stop();
    void this.audioCtx?.close();
  }
}
