import { defineConfig, devices } from '@playwright/test'

const PORT = 5599

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    video: process.env.PWVIDEO ? 'on' : 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node serve.mjs',
    port: PORT,
    reuseExistingServer: true,
    timeout: 20000,
  },
})
