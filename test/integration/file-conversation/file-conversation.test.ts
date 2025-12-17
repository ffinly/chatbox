/**
 * 文件对话集成测试
 *
 * 测试 AI 通过 tools (read_file, grep_file) 读取文件内容的机制
 *
 * 运行方式：
 * 1. 设置环境变量 CHATBOX_LICENSE_KEY
 * 2. npm run test:file-conversation
 *
 * 或者直接运行：
 * CHATBOX_LICENSE_KEY=your-key npx vitest run test/integration/file-conversation/file-conversation.test.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
// 设置 mock - 必须在其他导入之前
import { getTestPlatform, resetTestPlatform } from './setup'
import {
  runConversationTest as runTest,
  type TestFile,
  type TestResult,
} from './test-harness'

// 测试配置
const LICENSE_KEY = process.env.CHATBOX_LICENSE_KEY || ''
const TEST_OUTPUT_DIR = path.join(__dirname, '../../../test/output/file-conversation')
const TEST_CASES_DIR = path.join(__dirname, '../../../test/cases/file-conversation')

// 跳过条件
const shouldSkip = !LICENSE_KEY

// 默认的 system prompt，所有测试用例都会使用
const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant that can read and analyze files.
When the user attaches files, use the provided tools (read_file, grep_file) to access their content.
Always provide accurate and helpful responses based on the file content.
Be concise but thorough in your explanations.`

// 辅助函数：从磁盘加载测试文件
function loadTestFile(fileName: string, fileType: string = 'text/plain'): TestFile {
  const filePath = path.join(TEST_CASES_DIR, fileName)
  const content = fs.readFileSync(filePath, 'utf-8')
  // 使用简单的 storageKey 格式，避免 AI 解析时出错
  const storageKey = `test_file_${fileName.replace(/[^a-zA-Z0-9]/g, '_')}`

  return {
    storageKey,
    fileName,
    fileType,
    content,
  }
}

describe('File Conversation Integration Tests', () => {
  const results: TestResult[] = []

  beforeAll(() => {
    if (shouldSkip) {
      console.warn('⚠️  CHATBOX_LICENSE_KEY not set, skipping integration tests')
      return
    }

    // 确保输出目录存在
    if (!fs.existsSync(TEST_OUTPUT_DIR)) {
      fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true })
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log('File Conversation Integration Tests')
    console.log(`${'='.repeat(60)}`)
  })

  beforeEach(() => {
    resetTestPlatform()
  })

  afterEach(() => {
    resetTestPlatform()
  })

  afterAll(() => {
    if (results.length > 0) {
      // 导出所有结果
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outputPath = path.join(TEST_OUTPUT_DIR, `results-${timestamp}.json`)

      const exportData = {
        timestamp: new Date().toISOString(),
        summary: {
          total: results.length,
          passed: results.filter((r) => r.success).length,
          failed: results.filter((r) => !r.success).length,
        },
        results: results.map((r) => ({
          ...r,
          messages: r.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.contentParts
              ?.filter((p) => p.type === 'text')
              .map((p) => (p as any).text)
              .join(''),
            files: m.files?.map((f) => ({ name: f.name, storageKey: f.storageKey })),
          })),
        })),
      }

      fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2))
      console.log(`\nResults exported to: ${outputPath}`)
    }
  })

  // 封装 runTest 调用，收集结果并返回
  // 默认使用 DEFAULT_SYSTEM_PROMPT，可通过 options.systemPrompt 覆盖
  async function runConversationTest(
    testName: string,
    files: TestFile[],
    userMessage: string,
    validate?: (result: TestResult) => void,
    options?: { systemPrompt?: string; noSystemPrompt?: boolean }
  ): Promise<TestResult> {
    // 确定要使用的 system prompt
    // 1. 如果 noSystemPrompt 为 true，不使用任何 system prompt
    // 2. 如果提供了 options.systemPrompt，使用它
    // 3. 否则使用默认的 DEFAULT_SYSTEM_PROMPT
    const systemPrompt = options?.noSystemPrompt 
      ? undefined 
      : (options?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT)

    const result = await runTest({
      testName,
      files,
      userMessage,
      licenseKey: LICENSE_KEY,
      validate,
      platform: getTestPlatform(),
      systemPrompt,
    })
    results.push(result)
    return result
  }

  describe('Single File Tests', () => {
    it.skipIf(shouldSkip)('should read plain text file and answer questions', async () => {
      const textFile = loadTestFile('sample.txt')

      const result = await runConversationTest(
        'Plain Text File Q&A',
        [textFile],
        'Please read the attached file and tell me what is the User ID mentioned in it?',
        (result) => {
          expect(result.toolCalls.length).toBeGreaterThan(0)
          expect(result.toolCalls.some((tc) => tc.toolName === 'read_file')).toBe(true)

          const responseText = result.response?.contentParts
            ?.filter((p) => p.type === 'text')
            .map((p) => (p as any).text)
            .join('')
          expect(responseText).toContain('12345')
        }
      )

      expect(result.success).toBe(true)
    }, 60000)

    it.skipIf(shouldSkip)('should read TypeScript file and explain code', async () => {
      const tsFile = loadTestFile('sample.ts', 'text/typescript')

      const result = await runConversationTest(
        'TypeScript Code Analysis',
        [tsFile],
        'Please read the TypeScript file and explain what the Repository class does. What methods does it have?',
        (result) => {
          expect(result.toolCalls.some((tc) => tc.toolName === 'read_file')).toBe(true)

          const responseText = result.response?.contentParts
            ?.filter((p) => p.type === 'text')
            .map((p) => (p as any).text)
            .join('')
            .toLowerCase()

          expect(responseText).toMatch(/add|get|delete|count/)
        }
      )

      expect(result.success).toBe(true)
    }, 60000)

    it.skipIf(shouldSkip)('should read JSON file and extract data', async () => {
      const jsonFile = loadTestFile('sample.json', 'application/json')

      const result = await runConversationTest(
        'JSON Data Extraction',
        [jsonFile],
        'Please read the JSON file and tell me: 1) How many users are there? 2) What is the name of the admin user?',
        (result) => {
          const responseText = result.response?.contentParts
            ?.filter((p) => p.type === 'text')
            .map((p) => (p as any).text)
            .join('')

          expect(responseText).toMatch(/3|three/i)
          expect(responseText).toMatch(/Alice/i)
        }
      )

      expect(result.success).toBe(true)
    }, 60000)
  })

  describe('Grep File Tests', () => {
    it.skipIf(shouldSkip)('should use grep to search for specific content', async () => {
      const mdFile = loadTestFile('sample.md', 'text/markdown')

      const result = await runConversationTest(
        'Markdown Grep Search',
        [mdFile],
        'Search the attached markdown file for "RATE_LIMITED" and explain what this error code means.',
        (result) => {
          const usedTools = result.toolCalls.map((tc) => tc.toolName)
          expect(usedTools.some((t) => t === 'grep_file' || t === 'read_file')).toBe(true)

          const responseText = result.response?.contentParts
            ?.filter((p) => p.type === 'text')
            .map((p) => (p as any).text)
            .join('')
            .toLowerCase()

          expect(responseText).toMatch(/rate|limit|too many|429/)
        }
      )

      expect(result.success).toBe(true)
    }, 60000)
  })

  describe('Large File Tests', () => {
    it.skipIf(shouldSkip)('should handle large file with pagination', async () => {
      const largeFile = loadTestFile('sample-large.txt')

      const result = await runConversationTest(
        'Large File Pagination',
        [largeFile],
        'The attached file is very large. Please read it and tell me: 1) What is on the first line? 2) What marker is at the end of the file?',
        (result) => {
          const readCalls = result.toolCalls.filter((tc) => tc.toolName === 'read_file')
          expect(readCalls.length).toBeGreaterThanOrEqual(1)

          const responseText = result.response?.contentParts
            ?.filter((p) => p.type === 'text')
            .map((p) => (p as any).text)
            .join('')

          expect(responseText).toMatch(/Large Sample File|Pagination/i)
          expect(responseText).toMatch(/End of Large File|marker|600/i)
        }
      )

      expect(result.success).toBe(true)
    }, 120000)
  })

  describe('Multi-File Tests', () => {
    it.skipIf(shouldSkip)('should handle multiple files in one conversation', async () => {
      const textFile = loadTestFile('sample.txt')
      const jsonFile = loadTestFile('sample.json', 'application/json')

      const result = await runConversationTest(
        'Multi-File Analysis',
        [textFile, jsonFile],
        'I have attached two files: a text file and a JSON file. Please compare them and tell me if the API Key mentioned in the text file matches any configuration in the JSON file.',
        (result) => {
          const readCalls = result.toolCalls.filter((tc) => tc.toolName === 'read_file')
          expect(readCalls.length).toBeGreaterThanOrEqual(2)
        }
      )

      expect(result.success).toBe(true)
    }, 90000)
  })

  describe('Multi-Turn Conversation Tests', () => {
    it.skipIf(shouldSkip)('should answer follow-up questions about the same file', async () => {
      const tsFile = loadTestFile('sample.ts', 'text/typescript')

      const result = await runConversationTest(
        'Multi-Turn Follow-up',
        [tsFile],
        'Please read the TypeScript file and explain the fetchUserData function in detail. What error handling does it use?',
        (result) => {
          const responseText = result.response?.contentParts
            ?.filter((p) => p.type === 'text')
            .map((p) => (p as any).text)
            .join('')
            .toLowerCase()

          expect(responseText).toMatch(/try|catch|error|throw/)
        }
      )

      expect(result.success).toBe(true)
    }, 120000)
  })

  describe('System Prompt Tests', () => {
    it.skipIf(shouldSkip)('should respect system prompt instructions', async () => {
      const textFile = loadTestFile('sample.txt')

      const systemPrompt = `You are a helpful assistant that always responds in JSON format.
When asked about file content, structure your response as:
{
  "found": true/false,
  "value": "the value found",
  "context": "surrounding context"
}`

      const result = await runConversationTest(
        'System Prompt JSON Response',
        [textFile],
        'What is the User ID in the attached file? Respond in the JSON format specified.',
        (result) => {
          const responseText = result.response?.contentParts
            ?.filter((p) => p.type === 'text')
            .map((p) => (p as any).text)
            .join('')

          // 验证响应包含 JSON 格式
          expect(responseText).toMatch(/\{[\s\S]*"found"[\s\S]*\}/)
          expect(responseText).toContain('12345')
        },
        { systemPrompt }
      )

      expect(result.success).toBe(true)
    }, 60000)

    it.skipIf(shouldSkip)('should follow persona in system prompt', async () => {
      const textFile = loadTestFile('sample.txt')

      const systemPrompt = `You are a pirate assistant. You always respond in pirate speak, using words like "Arrr", "matey", "treasure", "ye", etc.
Always stay in character while providing accurate information.`

      const result = await runConversationTest(
        'System Prompt Pirate Persona',
        [textFile],
        'What is the User ID in the attached file?',
        (result) => {
          const responseText = result.response?.contentParts
            ?.filter((p) => p.type === 'text')
            .map((p) => (p as any).text)
            .join('')
            .toLowerCase()

          // 验证响应包含正确答案
          expect(responseText).toContain('12345')
          // 验证使用了海盗语气（至少包含一个海盗词汇）
          expect(responseText).toMatch(/arr|matey|ye|treasure|ahoy|cap'n/)
        },
        { systemPrompt }
      )

      expect(result.success).toBe(true)
    }, 60000)
  })
})
