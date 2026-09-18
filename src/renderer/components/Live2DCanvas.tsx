import { useEffect, useRef } from 'react';
import { Live2DStage } from '../live2d/stage';

interface Props {
  modelUrl: string;
  visible: boolean;
  /** 角色缩放倍率（1 = 适配窗口基准大小） */
  scale?: number;
  /** 角色水平位置 0~1 */
  posX?: number;
  /** 脚底偏移（像素）：角色脚底距可用区域底边的留白 */
  footInset?: number;
  /** 角色可用区域（舞台坐标），用于避让对话框等 UI；null 表示占满画布 */
  freeArea?: { x: number; y: number; width: number; height: number } | null;
  onReady?: (stage: Live2DStage) => void;
  onModelTap?: (hitAreas: string[]) => void;
}

/**
 * Live2D 渲染画布：铺满窗口底层，角色渲染于透明区域之上。
 * 鼠标移动驱动视线追踪（focus），点击驱动命中测试（tap）。
 *
 * 舞台（PIXI Application / WebGL 上下文）在挂载时创建一次并常驻；
 * 切换模型只调用 stage.loadModel 热替换模型，不重建 WebGL 上下文，
 * 避免部分驱动下上下文重建失败导致「不支持 WebGL」占位/报错。
 */
export default function Live2DCanvas({
  modelUrl,
  visible,
  scale = 1,
  posX = 0.5,
  footInset = 12,
  freeArea = null,
  onReady,
  onModelTap,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<Live2DStage | null>(null);
  const tapRef = useRef(onModelTap);
  tapRef.current = onModelTap;
  // 保存最新的缩放/位置/可用区域/模型 URL，供异步时机读取
  const transformRef = useRef({ scale, posX });
  transformRef.current = { scale, posX };
  const freeAreaRef = useRef(freeArea);
  freeAreaRef.current = freeArea;
  const modelUrlRef = useRef(modelUrl);
  modelUrlRef.current = modelUrl;
  /** 已交给舞台加载的模型 URL（含加载中的），用于避免重复/并发加载 */
  const loadedUrlRef = useRef<string | null>(null);

  // 挂载时创建一次舞台并加载初始模型；卸载时销毁
  useEffect(() => {
    if (!canvasRef.current) return;
    const stage = new Live2DStage(canvasRef.current);
    stageRef.current = stage;
    // 调试句柄：便于外部（开发者工具 / 自动化测试）检查模型运行状态
    (window as unknown as { __live2dStage?: Live2DStage }).__live2dStage = stage;

    // 立即上报舞台（含 WebGL 支持状态），便于 UI 决定是否显示占位形象
    onReady?.(stage);

    if (stage.supported) {
      stage.setModelTransform(transformRef.current.scale, transformRef.current.posX);
      stage.setFreeArea(freeAreaRef.current);
      loadedUrlRef.current = modelUrlRef.current;
      stage
        .loadModel(modelUrlRef.current, (hits) => tapRef.current?.(hits))
        .catch((err) => console.error('[live2d] 模型加载失败:', err));
    }

    const onResize = () => stage.resize();
    window.addEventListener('resize', onResize);

    // 用 ResizeObserver 监听画布父容器（尺寸由窗口决定，不受 PIXI 内联样式影响）。
    // 窗口紧凑/展开切换时，父容器盒变化会在布局落定后可靠触发，
    // 避免仅依赖 window.resize 事件时读到旧尺寸、导致角色按旧高度布局而被裁切。
    const parentEl = canvasRef.current.parentElement;
    let ro: ResizeObserver | null = null;
    if (parentEl && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => stage.resize());
      ro.observe(parentEl);
    }

    // 视线追踪：角色视线跟随鼠标
    const onMove = (e: MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      stage.focus(e.clientX - rect.left, e.clientY - rect.top);
    };
    window.addEventListener('mousemove', onMove);

    // 点击角色：转发到 Live2D 命中测试，触发 TapBody 等动作
    const onDown = (e: PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      stage.tap(e.clientX - rect.left, e.clientY - rect.top);
    };
    const canvasEl = canvasRef.current;
    canvasEl?.addEventListener('pointerdown', onDown);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMove);
      canvasEl?.removeEventListener('pointerdown', onDown);
      ro?.disconnect();
      stage.destroy();
      stageRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换模型：在同一舞台上热替换，不重建 WebGL 上下文
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !stage.supported) return;
    if (loadedUrlRef.current === modelUrl) return;
    loadedUrlRef.current = modelUrl;
    void stage
      .loadModel(modelUrl, (hits) => tapRef.current?.(hits))
      .then(() => {
        // 换模型后按当前窗口尺寸重排，避免残留旧布局导致显示不全
        stage.resize();
      })
      .catch((err) => console.error('[live2d] 模型加载失败:', err));
  }, [modelUrl]);

  // 缩放 / 水平位置变化时实时套用（设置面板拖动滑块即可看到效果）
  useEffect(() => {
    stageRef.current?.setModelTransform(scale, posX);
  }, [scale, posX]);

  // 脚底偏移变化时实时套用
  useEffect(() => {
    stageRef.current?.setFootInset(footInset);
  }, [footInset]);

  // 可用区域变化时实时避让（面板开合、拖拽、窗口尺寸变化）
  useEffect(() => {
    stageRef.current?.setFreeArea(freeArea);
  }, [freeArea]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ display: visible ? 'block' : 'none', pointerEvents: visible ? 'auto' : 'none' }}
    />
  );
}
