import { CHATBOX_BUILD_TARGET } from '@/variables'
import DesktopPlatform from './desktop_platform'
import type { Platform } from './interfaces'
import TestPlatform from './test_platform'
import WebPlatform from './web_platform'

function initPlatform(): Platform {
  // 测试环境使用 TestPlatform
  if (process.env.NODE_ENV === 'test') {
    return new TestPlatform()
  }
  if (typeof window !== 'undefined' && window.electronAPI) {
    return new DesktopPlatform(window.electronAPI)
  } else {
    return new WebPlatform()
  }
}

export default initPlatform()
