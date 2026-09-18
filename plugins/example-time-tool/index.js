/**
 * 示例插件：时间工具。
 * 演示标准插件 API —— 生命周期钩子 + 工具注册。
 * 运行于 node:vm 沙箱，仅暴露受限 API。
 */

module.exports = {
  onLoad(api) {
    console.log('时间工具插件已加载, pluginId =', api.pluginId);
  },

  onUnload() {
    console.log('时间工具插件已卸载');
  },

  onMessage(message) {
    // 可监听对话消息等事件
  },

  tools: {
    get_current_time(args) {
      const tz = (args && args.timezone) || 'Asia/Shanghai';
      try {
        return {
          ok: true,
          time: new Date().toLocaleString('zh-CN', { timeZone: tz }),
          timezone: tz,
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  },
};
