import * as PIXI from 'pixi.js';
import { resolveEmotion } from './emotionMap';

/** 双运行时（Cubism4 / Cubism2）共用的宽松模型类型 */
type ModelLike = any;

/** Cubism2 模型的情感→表情别名（模型无 Mao 系表情名时兜底） */
const CUBISM2_EXPRESSION_ALIAS: Record<string, string[]> = {
  happy: ['F_FUN', 'fun', 'happy', 'joy'],
  sad: ['F_SAD', 'sad'],
  angry: ['F_ANGRY', 'angry'],
  surprised: ['F_SURPRISE', 'surprise', 'surprised'],
  neutral: ['F_NOMAL', 'F_NORMAL', 'normal', 'neutral'],
};

/**
 * Live2D 舞台控制器：封装 pixi-live2d-display，
 * 负责模型加载（Cubism4 .model3.json / Cubism2 .model.json）、表情混合、
 * 动作播放、视线追踪与口型同步。
 * 对应开发文档「Live2D 角色系统」与「表情与动作映射」模块。
 */
export class Live2DStage {
  private app: PIXI.Application | null = null;
  private model: ModelLike = null;
  private motionPriority: any = null;
  private isCubism4 = true;
  private lipValue = 0;
  private lipActive = false;
  private expressionResetTimer: ReturnType<typeof setTimeout> | null = null;
  private detachLipHook: (() => void) | null = null;
  private tickerCallback: (() => void) | null = null;
  /** 用户设定的角色缩放倍率（1 = 适配窗口的基准大小） */
  private userScale = 1;
  /** 角色水平锚点 0~1 */
  private anchorX = 0.5;
  /** 脚底偏移（像素）：角色脚底距可用区域底边的留白，可配置 */
  private footInset = 12;
  /** 角色可用区域（避让 UI）；null 表示占满整个画布 */
  private freeArea: { x: number; y: number; width: number; height: number } | null = null;
  /** 缩放/位置的目标值，由 applyTween 逐帧逼近 */
  private target = { scale: 1, x: 0, y: 0 };
  /** 拖动冻结：拖动窗口/面板期间暂停重排，松手后一次性重排，避免拖动中放大/抖动 */
  private frozen = false;
  private onModelTap?: (hitAreas: string[]) => void;
  /** WebGL 是否可用（不可用时所有渲染操作降级为 no-op） */
  readonly supported: boolean;

  constructor(private canvas: HTMLCanvasElement) {
    try {
      this.app = new PIXI.Application({
        view: canvas,
        autoStart: true,
        backgroundAlpha: 0,
        antialias: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });
      this.supported = true;
      this.resize();
    } catch (err) {
      console.warn('[live2d] WebGL 不可用，角色渲染已禁用:', err);
      this.supported = false;
    }
  }

  /** 自适应容器尺寸 */
  resize(): void {
    if (!this.app || this.frozen) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth || window.innerWidth;
    const h = parent.clientHeight || window.innerHeight;
    this.app.renderer.resize(w, h);
    this.fitModel();
  }

  /** 拖动冻结开关：冻结期间暂停重排；解冻后立即重排一次 */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    if (!frozen) this.resize();
  }

  private fitModel(): void {
    if (!this.app || !this.model) return;
    const { width, height } = this.app.renderer;
    const ow = this.model.internalModel.originalWidth;
    const oh = this.model.internalModel.originalHeight;

    // 可用区域：默认为整个窗口；若设置了避让区域（如对话框之外的空白带），
    // 则只在该区域内排布，确保角色不被 UI 遮挡。
    const area = this.freeArea ?? { x: 0, y: 0, width, height };
    const availW = Math.max(1, area.width);
    const availH = Math.max(1, area.height);

    // 底部留白：让脚不贴住可用区域底边（窗口底边或面板上沿），
    // 避免脚被底边裁切、或紧贴面板显得被遮挡。
    // 整窗/紧凑态用可配置 footInset（可按屏幕调大）；避让态固定小间距，避免离对话框太远。
    const BOTTOM_INSET = this.freeArea ? 10 : this.footInset;
    const usableH = Math.max(1, availH - BOTTOM_INSET);

    // 基准缩放：让模型适配可用区域，再乘以用户设定的倍率。
    // 直接改 model.scale 而非 CSS transform，可让 WebGL 按新尺寸重新渲染，放大不失真。
    // 避让模式下可用区域已含边距，故用更紧凑的填充系数把角色放大一些。
    const fill = this.freeArea ? 0.98 : 0.9;
    const base = Math.min(availW / ow, usableH / oh) * fill;
    const s = base * this.userScale;
    const scaledW = ow * s;
    const scaledH = oh * s;

    this.target.scale = s;
    // 水平位置：0=最左 0.5=居中 1=最右（模型比可用区宽时会自然溢出两侧）
    this.target.x = area.x + (availW - scaledW) * this.anchorX;
    // 垂直方向底部对齐到「可用区域底边 - 底部留白」，角色"站"在留白之上，脚完整可见
    this.target.y = area.y + usableH - scaledH;

    // 立即落位（snap）而非补间渐变：尺寸/位置变化只发生在面板开合、窗口切换的那一瞬，
    // 不残留渐进补间，避免拖动中或拖动释放后角色继续放大/缩小。
    if (this.model && !this.frozen) {
      this.model.scale.set(this.target.scale, this.target.scale);
      this.model.x = this.target.x;
      this.model.y = this.target.y;
    }
  }

  /** 立即落到目标位置（用于首次加载，避免开场动画） */
  private snapToTarget(): void {
    if (!this.model) return;
    this.model.scale.set(this.target.scale, this.target.scale);
    this.model.x = this.target.x;
    this.model.y = this.target.y;
  }

  /**
   * 逐帧向目标缩放/位置插值，让面板开合、大小调整、拖拽避让都有平滑过渡。
   * 时间常数约 90ms，收敛后自动吸附以消除长期微小抖动。
   */
  private applyTween(dt: number): void {
    if (!this.model) return;
    // 拖动冻结期间暂停补间：角色尺寸/位置完全静止，避免拖动中出现逐渐放大/缩放跳动
    if (this.frozen) return;
    const k = 1 - Math.exp(-Math.max(dt, 1) / 90);
    const cur = this.model.scale.x;
    let ns = cur + (this.target.scale - cur) * k;
    if (Math.abs(this.target.scale - ns) < 1e-4) ns = this.target.scale;
    this.model.scale.set(ns, ns);

    let nx = this.model.x + (this.target.x - this.model.x) * k;
    let ny = this.model.y + (this.target.y - this.model.y) * k;
    if (Math.abs(this.target.x - nx) < 0.05) nx = this.target.x;
    if (Math.abs(this.target.y - ny) < 0.05) ny = this.target.y;
    this.model.x = nx;
    this.model.y = ny;
  }

  /** 读取模型可用动作组名（Cubism4 / Cubism2 结构不同，统一兜底） */
  private listMotionGroups(): string[] {
    const im = this.model?.internalModel;
    if (!im) return [];
    try {
      if (im.motionManager?.definitions) return Object.keys(im.motionManager.definitions);
      const motions = im.settings?.motions ?? im.motions ?? {};
      return Object.keys(motions);
    } catch {
      return [];
    }
  }

  /** 选取空闲动作组：优先 Idle/idle，否则取第一个可用组 */
  private pickIdleGroup(): string | undefined {
    const groups = this.listMotionGroups();
    const hit = groups.find((g) => g === 'Idle' || g === 'idle');
    return hit ?? groups[0];
  }

  /**
   * 设置角色大小与水平位置。
   * @param scale 缩放倍率（1 = 适配可用区域的基准大小）
   * @param posX  水平位置 0~1
   */
  setModelTransform(scale: number, posX: number): void {
    this.userScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    this.anchorX = Math.min(1, Math.max(0, Number.isFinite(posX) ? posX : 0.5));
    if (!this.frozen) this.fitModel();
  }

  /** 设置脚底偏移（像素）：角色脚底距可用区域底边的留白 */
  setFootInset(inset: number): void {
    this.footInset = Number.isFinite(inset) && inset >= 0 ? inset : 12;
    if (!this.frozen) this.fitModel();
  }

  /**
   * 设置角色的可用区域（舞台坐标），用于避让对话框等 UI。
   * 传 null 表示不避让，恢复占满整个窗口。
   */
  setFreeArea(area: { x: number; y: number; width: number; height: number } | null): void {
    this.freeArea = area && area.width > 1 && area.height > 1 ? area : null;
    if (!this.frozen) this.fitModel();
  }

  /** 将模型更新挂到本舞台的 ticker（驱动动画/物理/呼吸/眨眼/动作） */
  private attachTicker(model: ModelLike): void {
    if (!this.app) return;
    const tick = () => {
      const dt = this.app!.ticker.deltaMS;
      // 每帧自检窗口尺寸：比 resize/ResizeObserver 事件更可靠，
      // 紧凑/展开切换后即使事件时机滞后也能在下一帧重排，杜绝残留旧布局导致腿部被裁。
      // 拖动冻结期间跳过，避免拖动中瞬时尺寸引发放大/抖动。
      if (
        !this.frozen &&
        (this.app!.renderer.width !== window.innerWidth || this.app!.renderer.height !== window.innerHeight)
      ) {
        this.resize();
      }
      this.applyTween(dt);
      model.update(dt);
    };
    this.tickerCallback = tick;
    this.app.ticker.add(tick);
    this.app.ticker.start();
  }

  private detachTicker(): void {
    if (this.app && this.tickerCallback) this.app.ticker.remove(this.tickerCallback);
    this.tickerCallback = null;
  }

  /** 按 URL 后缀判定 Cubism 版本并动态加载对应运行时 */
  private async loadRuntime(url: string): Promise<{ Live2DModel: any; MotionPriority: any; isCubism4: boolean }> {
    const isCubism4 = /\.model3\.json(\?|#|$)/i.test(url);
    const mod = isCubism4
      ? await import('pixi-live2d-display/cubism4')
      : await import('pixi-live2d-display/cubism2');
    return { Live2DModel: mod.Live2DModel, MotionPriority: mod.MotionPriority, isCubism4 };
  }

  /** 加载模型（.model3.json = Cubism4；.model.json = Cubism2；支持热替换） */
  async loadModel(url: string, onTap?: (hitAreas: string[]) => void): Promise<void> {
    if (!this.app || !this.supported) throw new Error('WebGL 不可用');
    this.onModelTap = onTap;
    const app = this.app;

    const { Live2DModel, MotionPriority, isCubism4 } = await this.loadRuntime(url);

    // autoUpdate 依赖 window.PIXI.Ticker 或 Live2DModel.registerTicker()，
    // 二者在本项目均未设置，故关闭自动更新，改由本舞台的 ticker 显式驱动，
    // 确保 deltaTime 被累加（否则 internalModel.update 永不执行，角色静止不动）。
    // 先加载成功再替换旧模型：加载失败时保留旧模型，不破坏当前显示。
    const model = await Live2DModel.from(url, { autoInteract: false, autoUpdate: false });

    if (this.model) {
      app.stage.removeChild(this.model);
      this.model.destroy();
      this.detachTicker();
      this.detachLipHook?.();
      this.detachLipHook = null;
    }
    this.motionPriority = MotionPriority;
    this.isCubism4 = isCubism4;
    this.model = model;
    app.stage.addChild(model as unknown as PIXI.DisplayObject);

    this.attachTicker(model);

    // 口型同步钩子：仅 Cubism4 注入 ParamA（Mao 的 LipSync 参数）。
    // 必须挂在 afterMotionUpdate —— 其后紧接 saveParameters()，写入值才会被保存；
    // 若挂在 beforeModelUpdate，帧末的 loadParameters() 会把写入还原，口型失效。
    // Cubism2 参数体系不同，此处优雅跳过（不影响显示与动作）。
    if (isCubism4) {
      const internal = model.internalModel as unknown as {
        on: (ev: string, fn: () => void) => void;
        off: (ev: string, fn: () => void) => void;
        coreModel: { setParameterValueById: (id: string, v: number) => void };
      };
      const lipHook = () => {
        if (this.lipActive) {
          try {
            internal.coreModel.setParameterValueById('ParamA', this.lipValue);
          } catch {
            /* 参数不存在时忽略 */
          }
        }
      };
      internal.on('afterMotionUpdate', lipHook);
      this.detachLipHook = () => internal.off('afterMotionUpdate', lipHook);
    }

    // 点击交互
    model.on('hit', (hitAreas: string[]) => {
      this.onModelTap?.(hitAreas);
    });

    // 空闲动作循环（组名因模型/版本而异，自动探测）
    const idleGroup = this.pickIdleGroup();
    if (idleGroup !== undefined) {
      void model.motion(idleGroup, undefined, MotionPriority.IDLE);
    }

    this.fitModel();
    // 首次加载直接定位，不做补间动画
    this.snapToTarget();
  }

  /**
   * 应用情感标签：查询映射表 → 设置表情 → 触发动作序列。
   * 这是「表情-动作映射引擎」的核心入口。
   * 对不含对应表情/动作的模型（如 Cubism2）优雅降级为 no-op。
   */
  applyEmotion(emotion: string): void {
    if (!this.model) return;
    const rule = resolveEmotion(emotion);

    try {
      void this.model.expression(rule.expression);
      // Cubism2 模型常用 F_* 表情名，主名未命中时用别名兜底
      if (!this.isCubism4) {
        const aliases = CUBISM2_EXPRESSION_ALIAS[emotion] ?? CUBISM2_EXPRESSION_ALIAS.neutral;
        for (const name of aliases) {
          void this.model.expression(name);
        }
      }
    } catch {
      /* 模型无该表情时忽略 */
    }

    if (rule.motion) {
      try {
        void this.model.motion(rule.motion, undefined, this.motionPriority?.NORMAL);
      } catch {
        /* 模型无该动作组时忽略 */
      }
    }

    // 表情持续时间到期后回到 neutral
    if (this.expressionResetTimer) clearTimeout(this.expressionResetTimer);
    if (rule.duration && rule.duration > 0) {
      this.expressionResetTimer = setTimeout(() => {
        if (this.model) {
          try {
            void this.model.expression('exp_01');
            if (!this.isCubism4) void this.model.expression('F_NOMAL');
          } catch {
            /* ignore */
          }
        }
      }, rule.duration);
    }
  }

  /** 设置指定表情文件 */
  setExpression(name: string): void {
    if (!this.model) return;
    try {
      void this.model.expression(name);
    } catch {
      /* ignore */
    }
  }

  /** 播放动作组中的随机动作 */
  playMotion(group: string): void {
    if (!this.model) return;
    try {
      void this.model.motion(group, undefined, this.motionPriority?.NORMAL);
    } catch {
      /* ignore */
    }
  }

  /** 停止当前动作并回到 idle（状态机复位后会自动重新拉起 Idle 动作组） */
  stopMotions(): void {
    const im = this.model?.internalModel as unknown as
      | { motionManager?: { stopAllMotions?: () => void } }
      | undefined;
    try {
      im?.motionManager?.stopAllMotions?.();
    } catch {
      /* ignore */
    }
  }

  /** 视线追踪：将角色视线聚焦到舞台坐标 (x, y) */
  focus(x: number, y: number): void {
    try {
      this.model?.focus(x, y);
    } catch {
      /* ignore */
    }
  }

  /** 模拟点击角色（触发动作） */
  tap(x: number, y: number): void {
    try {
      this.model?.tap(x, y);
    } catch {
      /* ignore */
    }
  }

  /** 命中测试：返回该舞台坐标命中的 hit area 名称（如 Head / Body） */
  hitTest(x: number, y: number): string[] {
    if (!this.model) return [];
    try {
      return this.model.hitTest(x, y) ?? [];
    } catch {
      return [];
    }
  }

  /** 开始说话：启用口型同步 */
  startSpeaking(): void {
    this.lipActive = true;
  }

  /** 停止说话：关闭口型并归零 */
  stopSpeaking(): void {
    this.lipActive = false;
    this.lipValue = 0;
  }

  /** 设置口型开合度 0~1（由音频波形分析驱动） */
  setLipSync(value: number): void {
    this.lipValue = Math.max(0, Math.min(1, value));
  }

  /**
   * 运行时诊断快照：用于排查「角色不动」类问题与自动化验证。
   * elapsedTime 持续增长即代表更新循环正常驱动。
   */
  diagnostics(): Record<string, unknown> {
    if (!this.model) return { loaded: false, supported: this.supported };
    const m = this.model as ModelLike;
    const im = m.internalModel;
    const read = (id: string): number => {
      try {
        if (im?.coreModel?.getParameterValueById) return im.coreModel.getParameterValueById(id);
        if (im?.coreModel?.getParamFloat) return im.coreModel.getParamFloat(id);
        return NaN;
      } catch {
        return NaN;
      }
    };
    const em = im?.motionManager?.expressionManager;
    const exprIndex = em && em.expressions ? em.expressions.indexOf(em.currentExpression) : null;
    return {
      loaded: true,
      supported: this.supported,
      cubism4: this.isCubism4,
      autoUpdate: m.autoUpdate,
      tickerAttached: this.tickerCallback !== null,
      // Live2DModel.update(dt) 中累加，持续增长即代表更新循环被驱动
      elapsedTime: m.elapsedTime,
      modelDeltaTime: m.deltaTime,
      currentMotionGroup: im?.motionManager?.state?.currentGroup ?? null,
      playingMotion: !!im?.motionManager?.playing,
      currentExpressionIndex: exprIndex !== null && exprIndex >= 0 ? exprIndex : null,
      ParamAngleZ: read('ParamAngleZ'),
      ParamBreath: read('ParamBreath'),
      ParamEyeLOpen: read('ParamEyeLOpen'),
      ParamA: read('ParamA'),
      // 模型在画布中的屏幕区域，便于定位点击/自动化测试
      modelRect: {
        x: Math.round(m.x),
        y: Math.round(m.y),
        width: Math.round(m.width),
        height: Math.round(m.height),
      },
      // 当前避让可用区域（null 表示占满整窗），用于排查遮挡/布局问题
      freeArea: this.freeArea,
    };
  }

  destroy(): void {
    this.detachTicker();
    this.detachLipHook?.();
    if (this.expressionResetTimer) clearTimeout(this.expressionResetTimer);
    this.model?.destroy();
    this.app?.destroy(true, { children: true });
  }
}
