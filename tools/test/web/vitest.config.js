import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 默认 node 环境跑纯 reducer 测试;renderer 测试文件用 // @vitest-environment jsdom 顶注切换
    environment: 'node',
    include: ['unit/**/*.test.js', 'contract/**/*.test.js'],
    reporters: 'default',
  },
})
