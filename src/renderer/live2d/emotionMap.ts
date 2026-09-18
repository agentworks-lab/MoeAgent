import type { EmotionMap } from '../../shared/types';

/**
 * 表情-动作映射引擎的配置表。
 * 将 LLM 输出的情感标签映射为 Mao 模型的表情文件（exp_01~08）与动作组。
 *
 * Mao 表情文件语义（来自官方示例模型）：
 *  exp_01 普通 | exp_02 眼睛笑（开心） | exp_03 平静 | exp_04 星星眼（害羞/兴奋）
 *  exp_05 沮丧（难过） | exp_06 脸红尴尬 | exp_07 惊讶 | exp_08 生气
 */
export const EMOTION_MAP: EmotionMap = {
  happy: { expression: 'exp_02', motion: 'TapBody', intensity: 1, duration: 8000 },
  shy: { expression: 'exp_04', intensity: 1, duration: 8000 },
  sad: { expression: 'exp_05', intensity: 1, duration: 10000 },
  thinking: { expression: 'exp_03', intensity: 0.8, duration: 8000 },
  angry: { expression: 'exp_08', motion: 'TapBody', intensity: 1, duration: 6000 },
  surprised: { expression: 'exp_07', intensity: 1, duration: 5000 },
  embarrassed: { expression: 'exp_06', intensity: 1, duration: 6000 },
  neutral: { expression: 'exp_01', intensity: 1, duration: 0 },
};

/** 未知情感的回退规则 */
export const FALLBACK_RULE = EMOTION_MAP.neutral;

export function resolveEmotion(emotion: string) {
  return EMOTION_MAP[emotion.toLowerCase()] ?? FALLBACK_RULE;
}
