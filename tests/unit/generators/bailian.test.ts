import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock 依赖
const getProviderConfigMock = vi.hoisted(() =>
  vi.fn(async () => ({
    id: 'bailian',
    apiKey: 'test-api-key',
  })),
)

const imageUrlToBase64Mock = vi.hoisted(() =>
  vi.fn(async (url: string) => {
    if (url.startsWith('data:')) {
      return url
    }
    return 'data:image/png;base64,testBase64Data'
  }),
)

const logInfoMock = vi.hoisted(() => vi.fn())
const logErrorMock = vi.hoisted(() => vi.fn())
const logWarnMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-config', () => ({
  getProviderConfig: getProviderConfigMock,
}))

vi.mock('@/lib/cos', () => ({
  imageUrlToBase64: imageUrlToBase64Mock,
}))

vi.mock('@/lib/logging/core', () => ({
  logInfo: logInfoMock,
  logError: logErrorMock,
  logWarn: logWarnMock,
}))

// 导入被测试模块
import { BailianImageGenerator, BailianVideoGenerator } from '@/lib/generators/bailian'

describe('BailianImageGenerator', () => {
  let generator: BailianImageGenerator
  const originalFetch = global.fetch

  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    generator = new BailianImageGenerator()
  })

  describe('doGenerate', () => {
    it('should generate image successfully with default options', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            results: [{ url: 'https://example.com/generated-image.png' }],
          },
        }),
      })

      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'a beautiful sunset',
      })

      expect(result.success).toBe(true)
      expect(result.imageUrl).toBe('https://example.com/generated-image.png')

      // 验证 fetch 调用
      expect(global.fetch).toHaveBeenCalledTimes(1)
      const [url, options] = (global.fetch as any).mock.calls[0]
      expect(url).toContain('dashscope.aliyuncs.com')
      expect(options.method).toBe('POST')
      expect(options.headers.Authorization).toBe('Bearer test-api-key')

      const body = JSON.parse(options.body)
      expect(body.model).toBe('wan2.6-t2i')
      expect(body.parameters.size).toBe('960*1280')
      expect(body.input.messages[0].role).toBe('user')
    })

    it('should generate image with OpenAI-style response format', async () => {
      // 新的 OpenAI 风格响应格式
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            choices: [{
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: [{
                  image: 'https://dashscope-example.oss-cn-shanghai.aliyuncs.com/generated-image.png'
                }]
              }
            }]
          },
        }),
      })

      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'a beautiful sunset',
      })

      expect(result.success).toBe(true)
      expect(result.imageUrl).toBe('https://dashscope-example.oss-cn-shanghai.aliyuncs.com/generated-image.png')
    })

    it('should generate image with custom model and size', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            results: [{ url: 'https://example.com/generated-image.png' }],
          },
        }),
      })

      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'a cat',
        options: {
          modelId: 'wan2.6-t2i-custom',
          size: '1024*1024',
          watermark: true,
        },
      })

      expect(result.success).toBe(true)

      const [, options] = (global.fetch as any).mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.model).toBe('wan2.6-t2i-custom')
      expect(body.parameters.size).toBe('1024*1024')
      expect(body.parameters.watermark).toBe(true)
    })

    it('should handle reference images', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            results: [{ url: 'https://example.com/generated-image.png' }],
          },
        }),
      })

      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'make it more colorful',
        referenceImages: [
          'https://example.com/ref1.png',
          'data:image/png;base64,base64Image',
        ],
      })

      expect(result.success).toBe(true)

      const [, options] = (global.fetch as any).mock.calls[0]
      const body = JSON.parse(options.body)
      const content = body.input.messages[0].content

      // 应该包含 2 个参考图片 + 1 个文本提示词
      expect(content).toHaveLength(3)
      expect(content[0]).toHaveProperty('image')
      expect(content[1]).toHaveProperty('image')
      expect(content[2]).toHaveProperty('text', 'make it more colorful')
    })

    it('should throw error for unsupported option key', async () => {
      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'test',
        options: {
          unsupportedOption: 'value',
        } as Record<string, unknown>,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('BAILIAN_IMAGE_OPTION_UNSUPPORTED')
      expect(result.error).toContain('unsupportedOption')
    })

    it('should throw error for unsupported size value', async () => {
      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'test',
        options: {
          size: '100*100',
        },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('BAILIAN_IMAGE_OPTION_VALUE_UNSUPPORTED')
      expect(result.error).toContain('size=100*100')
    })

    it('should handle API error response', async () => {
      // 基类重试逻辑会调用 fetch 3 次（maxRetries=3）
      ;(global.fetch as any)
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => 'Bad Request',
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => 'Bad Request',
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => 'Bad Request',
        })

      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'test',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Bailian API Error')
      expect(result.error).toContain('400')
    })

    it('should handle Bailian error in output', async () => {
      // 基类重试逻辑会调用 fetch 3 次（maxRetries=3）
      ;(global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              code: 'InvalidParameter',
              message: 'Invalid prompt',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              code: 'InvalidParameter',
              message: 'Invalid prompt',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              code: 'InvalidParameter',
              message: 'Invalid prompt',
            },
          }),
        })

      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'test',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid prompt')
    })

    it('should handle root level error', async () => {
      // DashScope API 有时在根级别返回错误
      // 基类重试逻辑会调用 fetch 3 次（maxRetries=3）
      ;(global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            code: 'QuotaExceeded',
            message: 'API quota exceeded',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            code: 'QuotaExceeded',
            message: 'API quota exceeded',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            code: 'QuotaExceeded',
            message: 'API quota exceeded',
          }),
        })

      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'test',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('API quota exceeded')
    })

    it('should handle empty results', async () => {
      // 基类重试逻辑会调用 fetch 3 次（maxRetries=3）
      ;(global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              results: [],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              results: [],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              results: [],
            },
          }),
        })

      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'test',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('未返回图片结果')
    })

    it('should accept allowed option keys', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            results: [{ url: 'https://example.com/image.png' }],
          },
        }),
      })

      // 测试所有允许的选项键
      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'test',
        options: {
          provider: 'bailian',
          modelId: 'wan2.6-t2i',
          modelKey: 'bailian::wan2.6-t2i',
          size: '720*1280',
          watermark: false,
          aspectRatio: '9:16',
          stream: false, // 兼容参数
        },
      })

      expect(result.success).toBe(true)
    })
  })
})

describe('BailianVideoGenerator', () => {
  let generator: BailianVideoGenerator

  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    generator = new BailianVideoGenerator()
  })

  describe('doGenerate', () => {
    it('should submit video generation task successfully', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_id: 'task-123',
            task_status: 'PENDING',
          },
        }),
      })

      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'animate this image',
      })

      expect(result.success).toBe(true)
      expect(result.async).toBe(true)
      expect(result.requestId).toBe('task-123')
      expect(result.externalId).toBe('BAILIAN:VIDEO:task-123')

      // 验证 fetch 调用
      const [url, options] = (global.fetch as any).mock.calls[0]
      expect(url).toContain('video-synthesis')
      expect(options.headers['X-DashScope-Async']).toBe('enable')

      const body = JSON.parse(options.body)
      expect(body.model).toBe('wan2.6-i2v')
      expect(body.input.prompt).toBe('animate this image')
      expect(body.parameters.resolution).toBe('720P')
      expect(body.parameters.duration).toBe(5)
    })

    it('should use custom model, resolution and duration', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_id: 'task-custom',
            task_status: 'PENDING',
          },
        }),
      })

      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'custom animation',
        options: {
          modelId: 'wan2.6-i2v-flash',
          resolution: '1080P',
          duration: 5,
          watermark: true,
        },
      })

      expect(result.success).toBe(true)

      const [, options] = (global.fetch as any).mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.model).toBe('wan2.6-i2v-flash')
      expect(body.parameters.resolution).toBe('1080P')
      expect(body.parameters.duration).toBe(5)
      expect(body.parameters.watermark).toBe(true)
    })

    it('should include audio URL when provided', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_id: 'task-with-audio',
            task_status: 'PENDING',
          },
        }),
      })

      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'lip sync',
        options: {
          audioUrl: 'https://example.com/audio.mp3',
        },
      })

      expect(result.success).toBe(true)

      const [, options] = (global.fetch as any).mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.input.audio_url).toBe('https://example.com/audio.mp3')
    })

    it('should convert image URL to base64', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_id: 'task-converted',
            task_status: 'PENDING',
          },
        }),
      })

      await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'test',
      })

      expect(imageUrlToBase64Mock).toHaveBeenCalledWith('https://example.com/seed.png')
    })

    it('should use base64 image directly if already prefixed', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_id: 'task-direct',
            task_status: 'PENDING',
          },
        }),
      })

      const base64Url = 'data:image/png;base64,abc123'
      await generator.generate({
        userId: 'user-1',
        imageUrl: base64Url,
        prompt: 'test',
      })

      // 不应该调用 imageUrlToBase64 因为已经是 data: 前缀
      const [, options] = (global.fetch as any).mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.input.img_url).toBe(base64Url)
    })

    it('should throw error for unsupported option key', async () => {
      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'test',
        options: {
          unsupportedOption: 'value',
        } as Record<string, unknown>,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('BAILIAN_VIDEO_OPTION_UNSUPPORTED')
      expect(result.error).toContain('unsupportedOption')
    })

    it('should throw error for unsupported resolution', async () => {
      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'test',
        options: {
          resolution: '4K',
        },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('BAILIAN_VIDEO_OPTION_VALUE_UNSUPPORTED')
      expect(result.error).toContain('resolution=4K')
    })

    it('should throw error for unsupported duration', async () => {
      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'test',
        options: {
          duration: 10,
        },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('BAILIAN_VIDEO_OPTION_VALUE_UNSUPPORTED')
      expect(result.error).toContain('duration=10')
    })

    it('should handle API error response', async () => {
      // 基类重试逻辑会调用 fetch 3 次（maxRetries=3）
      ;(global.fetch as any)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        })

      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'test',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Bailian API Error')
      expect(result.error).toContain('500')
    })

    it('should handle Bailian error in output', async () => {
      // 基类重试逻辑会调用 fetch 3 次（maxRetries=3）
      ;(global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              code: 'QuotaExceeded',
              message: 'Quota exceeded',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              code: 'QuotaExceeded',
              message: 'Quota exceeded',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              code: 'QuotaExceeded',
              message: 'Quota exceeded',
            },
          }),
        })

      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'test',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Quota exceeded')
    })

    it('should handle root level error for video', async () => {
      // DashScope API 有时在根级别返回错误
      // 基类重试逻辑会调用 fetch 3 次（maxRetries=3）
      ;(global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            code: 'QuotaExceeded',
            message: 'API quota exceeded',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            code: 'QuotaExceeded',
            message: 'API quota exceeded',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            code: 'QuotaExceeded',
            message: 'API quota exceeded',
          }),
        })

      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'test',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('API quota exceeded')
    })

    it('should handle missing task_id', async () => {
      // 基类重试逻辑会调用 fetch 3 次（maxRetries=3）
      ;(global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              task_status: 'PENDING',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              task_status: 'PENDING',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            output: {
              task_status: 'PENDING',
            },
          }),
        })

      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'test',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('未返回task_id')
    })

    it('should accept allowed option keys', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_id: 'task-all-options',
            task_status: 'PENDING',
          },
        }),
      })

      // 测试所有允许的选项键
      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'test',
        options: {
          provider: 'bailian',
          modelId: 'wan2.6-i2v',
          modelKey: 'bailian::wan2.6-i2v',
          resolution: '480P',
          duration: 5,
          watermark: false,
          audioUrl: 'https://example.com/audio.mp3',
          aspectRatio: '16:9', // 接受但不传给 API
          stream: false, // 兼容参数
        },
      })

      expect(result.success).toBe(true)
    })

    it('should work without prompt', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_id: 'task-no-prompt',
            task_status: 'PENDING',
          },
        }),
      })

      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        // 无 prompt
      })

      expect(result.success).toBe(true)

      const [, options] = (global.fetch as any).mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.input.prompt).toBe('')
    })
  })
})

describe('Bailian Supported Values', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should support all defined image sizes', async () => {
    const generator = new BailianImageGenerator()
    const supportedSizes = [
      '512*512',
      '720*720',
      '960*960',
      '1024*1024',
      '720*1280',
      '1280*720',
      '960*1280',
      '1280*960',
      '768*1024',
      '1024*768',
    ]

    for (const size of supportedSizes) {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            results: [{ url: 'https://example.com/image.png' }],
          },
        }),
      })

      const result = await generator.generate({
        userId: 'user-1',
        prompt: 'test',
        options: { size },
      })

      expect(result.success).toBe(true)
    }
  })

  it('should support all defined video resolutions', async () => {
    const generator = new BailianVideoGenerator()
    const supportedResolutions = ['480P', '720P', '1080P']

    for (const resolution of supportedResolutions) {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            task_id: `task-${resolution}`,
            task_status: 'PENDING',
          },
        }),
      })

      const result = await generator.generate({
        userId: 'user-1',
        imageUrl: 'https://example.com/seed.png',
        prompt: 'test',
        options: { resolution },
      })

      expect(result.success).toBe(true)
    }
  })
})