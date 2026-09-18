/**
 * 录音器：用 MediaRecorder 采集麦克风音频并输出 base64，
 * 供 Whisper API（OpenAI 兼容 /audio/transcriptions）转写使用。
 */
export class AudioRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mime = '';

  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  }

  /** 开始录音，返回是否成功启动 */
  async start(): Promise<boolean> {
    if (this.recorder) return false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (err) {
      console.warn('[recorder] 无法访问麦克风:', err);
      return false;
    }

    // 优先选 Whisper 支持的容器格式
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const picked = candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? '';
    this.mime = picked;
    this.chunks = [];

    try {
      this.recorder = picked ? new MediaRecorder(this.stream, { mimeType: picked }) : new MediaRecorder(this.stream);
    } catch (err) {
      console.warn('[recorder] MediaRecorder 创建失败:', err);
      this.release();
      return false;
    }
    this.mime = this.recorder.mimeType || picked || 'audio/webm';

    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250);
    return true;
  }

  /** 停止录音并返回 base64 音频；无有效数据时返回 null */
  async stop(): Promise<{ base64: string; mime: string } | null> {
    const recorder = this.recorder;
    if (!recorder) return null;

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      /* ignore */
    }
    await stopped;
    await new Promise((r) => setTimeout(r, 50));

    const mime = this.mime;
    const blob = new Blob(this.chunks, { type: mime });
    this.release();

    if (blob.size < 1024) return null; // 录音过短，视为无效
    const base64 = await blobToBase64(blob);
    return { base64, mime };
  }

  /** 丢弃录音并释放麦克风 */
  cancel(): void {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      /* ignore */
    }
    this.release();
  }

  private release(): void {
    this.chunks = [];
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** Blob → base64（去掉 data:...;base64, 前缀） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
