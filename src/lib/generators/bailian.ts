import {
  logInfo as _ulogInfo,
  logWarn as _ulogWarn,
  logError as _ulogError,
} from '@/lib/logging/core';
/**
 * 百炼（Bailian）生成器
 *
 * 支持模型：
 * - 图像：wan2.6-image（同步返回）
 * - 视频：wan2.6-i2v-flash（异步轮询）
 *
 * API 文档：
 * - 图像生成: https://help.aliyun.com/zh/model-studio/developer-reference/api-details-9
 * - 视频生成: https://help.aliyun.com/zh/model-studio/developer-reference/api-details-10
 */

import {
  BaseImageGenerator,
  BaseVideoGenerator,
  ImageGenerateParams,
  VideoGenerateParams,
  GenerateResult,
} from './base';
import { getProviderConfig } from '@/lib/api-config';
import { imageUrlToBase64 } from '@/lib/cos';

const BAILIAN_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc';

// Bailian 支持的图像尺寸
const BAILIAN_IMAGE_SIZES = new Set([
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
]);

// Bailian 支持的视频分辨率
const BAILIAN_VIDEO_RESOLUTIONS = new Set(['480P', '720P', '1080P']);

// Bailian 支持的视频时长
const BAILIAN_VIDEO_DURATIONS = new Set([5]);

interface BailianImageOptions {
  modelId?: string;
  modelKey?: string;
  size?: string;
  watermark?: boolean;
}

interface BailianVideoOptions {
  modelId?: string;
  modelKey?: string;
  resolution?: string;
  duration?: number;
  watermark?: boolean;
  audioUrl?: string;
}

interface BailianVideoRequestBody {
  model: string;
  input: {
    prompt: string;
    img_url: string;
    audio_url?: string;
  };
  parameters: {
    watermark: boolean;
    resolution: string;
    duration: number;
  };
}

// ==================== 图像生成器 ====================

// 429 限流重试配置
const RATE_LIMIT_MAX_RETRIES = 5
const RATE_LIMIT_BASE_DELAY_MS = 10_000  // 10 秒基础延迟

export class BailianImageGenerator extends BaseImageGenerator {
  protected async doGenerate(
    params: ImageGenerateParams,
  ): Promise<GenerateResult> {
    const { userId, prompt, referenceImages, options = {} } = params;
    const logPrefix = '[Bailian Image]';

    const { apiKey } = await getProviderConfig(userId, 'bailian');
    const rawOptions = options as BailianImageOptions;

    // 验证选项
    // 注意：stream 参数用于 ARK 等 provider，Bailian 不支持但需要兼容过滤
    const allowedOptionKeys = new Set([
      'provider',
      'modelId',
      'modelKey',
      'size',
      'watermark',
      'aspectRatio',
      'stream',
    ]);
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) continue;
      if (!allowedOptionKeys.has(key)) {
        throw new Error(`BAILIAN_IMAGE_OPTION_UNSUPPORTED: ${key}`);
      }
    }

    // 解析尺寸
    const size = rawOptions.size || '960*1280';
    if (!BAILIAN_IMAGE_SIZES.has(size)) {
      throw new Error(`BAILIAN_IMAGE_OPTION_VALUE_UNSUPPORTED: size=${size}`);
    }

    // 构建消息内容
    const content: Array<{ text: string } | { image: string }> = [];

    // 添加参考图片（如果存在）
    if (referenceImages && referenceImages.length > 0) {
      for (const refImage of referenceImages) {
        if (refImage.startsWith('data:')) {
          content.push({ image: refImage });
        } else {
          const base64Image = await imageUrlToBase64(refImage);
          content.push({ image: base64Image });
        }
      }
      _ulogInfo(`${logPrefix} 使用 ${referenceImages.length} 张参考图片`);
    }

    // 添加提示词文本
    content.push({ text: prompt });

    // 获取用户配置的模型，如果没有则使用默认模型
    const modelId = (rawOptions.modelId as string) || 'wan2.6-t2i';

    // Bailian API: enable_interleave=true 允许图文交错（最后一条可以是纯文本）
    // enable_interleave=false 时要求最后一条消息必须包含 1-4 张图片
    // 始终启用 interleaved 模式，这样无论有无参考图片都能正常工作
    const requestBody = {
      model: modelId,
      input: {
        messages: [
          {
            role: 'user' as const,
            content,
          },
        ],
        enable_interleave: true,
      },
      parameters: {
        watermark: rawOptions.watermark ?? false,
        size,
        n: 1,
      },
    };

    _ulogInfo(`${logPrefix} 提交任务, size=${size}`);
    _ulogInfo(`${logPrefix} 请求体:`, JSON.stringify(requestBody, null, 2));

    // 🔥 429 限流重试循环
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(
          `${BAILIAN_BASE_URL}/multimodal-generation/generation`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          },
        );

        if (!response.ok) {
          const errorText = await response.text();

          // 🔥 检测 429 限流错误
          if (response.status === 429) {
            const delayMs = RATE_LIMIT_BASE_DELAY_MS * Math.pow(1.5, attempt) + Math.random() * 5000;
            _ulogWarn(`${logPrefix} 收到 429 限流，等待 ${Math.round(delayMs / 1000)} 秒后重试 (尝试 ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            lastError = new Error(`RATE_LIMIT: ${errorText}`);
            continue;
          }

          _ulogError(`${logPrefix} API请求失败:`, response.status, errorText);
          throw new Error(`Bailian API Error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        _ulogInfo(`${logPrefix} API响应:`, JSON.stringify(data, null, 2));

        // 检查根级别错误（DashScope API 错误通常返回在根级别）
        if (data.code || data.message) {
          // 🔥 检测限流错误码
          if (data.code === 'Throttling.RateQuota' || String(data.code).includes('Throttl')) {
            const delayMs = RATE_LIMIT_BASE_DELAY_MS * Math.pow(1.5, attempt) + Math.random() * 5000;
            _ulogWarn(`${logPrefix} 收到限流错误 ${data.code}，等待 ${Math.round(delayMs / 1000)} 秒后重试`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            lastError = new Error(`RATE_LIMIT: ${data.message}`);
            continue;
          }
          throw new Error(`Bailian: ${data.message || data.code}`);
        }

        // 解析响应
        const output = data.output;
        if (!output) {
          throw new Error('Bailian未返回output');
        }

        // 检查 output 中的错误
        if (output.code || output.message) {
          throw new Error(`Bailian: ${output.message || output.code}`);
        }

        // 解析图片 URL - 支持两种响应格式
        let imageUrl: string | undefined;

        // 格式1: OpenAI 风格 choices[].message.content[].image
        if (output.choices && Array.isArray(output.choices) && output.choices.length > 0) {
          const choice = output.choices[0];
          const content = choice?.message?.content;
          if (Array.isArray(content) && content.length > 0) {
            // 查找第一个包含 image 的内容项
            for (const item of content) {
              if (item && typeof item.image === 'string') {
                imageUrl = item.image;
                break;
              }
            }
          }
        }
        // 格式2: 传统格式 results[].url
        else if (output.results && Array.isArray(output.results) && output.results.length > 0) {
          imageUrl = output.results[0]?.url;
        }

        if (!imageUrl) {
          // 尝试从 output 中提取更多错误信息
          const outputStr = JSON.stringify(output);
          throw new Error(`Bailian未返回图片结果，output内容: ${outputStr.substring(0, 500)}`);
        }

        _ulogInfo(`${logPrefix} 生成成功: ${imageUrl.substring(0, 80)}...`);

        return {
          success: true,
          imageUrl,
        };
      } catch (error: unknown) {
        // 如果是 RATE_LIMIT 错误，继续重试
        if (error instanceof Error && error.message.startsWith('RATE_LIMIT:')) {
          lastError = error;
          continue;
        }
        _ulogError(`${logPrefix} 生成失败:`, error);
        throw error;
      }
    }

    // 所有重试都失败
    _ulogError(`${logPrefix} 429 重试全部失败，共 ${RATE_LIMIT_MAX_RETRIES} 次`);
    throw lastError || new Error('RATE_LIMIT: 超过最大重试次数');
  }
}

// ==================== 视频生成器 ====================

export class BailianVideoGenerator extends BaseVideoGenerator {
  protected async doGenerate(
    params: VideoGenerateParams,
  ): Promise<GenerateResult> {
    const { userId, imageUrl, prompt = '', options = {} } = params;
    const logPrefix = '[Bailian Video]';

    const { apiKey } = await getProviderConfig(userId, 'bailian');
    const rawOptions = options as BailianVideoOptions;

    // 验证选项
    // 注意：stream 参数用于 ARK 等 provider，Bailian 不支持但需要兼容过滤
    const allowedOptionKeys = new Set([
      'provider',
      'modelId',
      'modelKey',
      'resolution',
      'duration',
      'watermark',
      'audioUrl',
      'aspectRatio', // 接受但不传给 API
      'stream', // 兼容 ARK 等 provider 的参数，Bailian 会忽略
    ]);
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) continue;
      if (!allowedOptionKeys.has(key)) {
        throw new Error(`BAILIAN_VIDEO_OPTION_UNSUPPORTED: ${key}`);
      }
    }

    // 解析分辨率
    const resolution = rawOptions.resolution || '720P';
    if (!BAILIAN_VIDEO_RESOLUTIONS.has(resolution)) {
      throw new Error(
        `BAILIAN_VIDEO_OPTION_VALUE_UNSUPPORTED: resolution=${resolution}`,
      );
    }

    // 解析时长
    const duration = rawOptions.duration || 5;
    if (!BAILIAN_VIDEO_DURATIONS.has(duration)) {
      throw new Error(
        `BAILIAN_VIDEO_OPTION_VALUE_UNSUPPORTED: duration=${duration}`,
      );
    }

    // 转换图片为 base64（如果需要）
    const imageDataUrl = imageUrl.startsWith('data:')
      ? imageUrl
      : await imageUrlToBase64(imageUrl);

    // 获取用户配置的模型，如果没有则使用默认模型
    const modelId = rawOptions.modelId || 'wan2.6-i2v';

    const requestBody: BailianVideoRequestBody = {
      model: modelId,
      input: {
        prompt,
        img_url: imageDataUrl,
      },
      parameters: {
        watermark: rawOptions.watermark ?? false,
        resolution,
        duration,
      },
    };

    // 添加音频URL（可选）
    if (rawOptions.audioUrl) {
      requestBody.input.audio_url = rawOptions.audioUrl;
    }

    _ulogInfo(
      `${logPrefix} 提交任务, resolution=${resolution}, duration=${duration}s`,
    );

    try {
      const response = await fetch(
        `${BAILIAN_BASE_URL}/video-generation/video-synthesis`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-DashScope-Async': 'enable', // 启用异步模式
          },
          body: JSON.stringify(requestBody),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        _ulogError(`${logPrefix} API请求失败:`, response.status, errorText);
        throw new Error(`Bailian API Error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      _ulogInfo(`${logPrefix} API响应:`, JSON.stringify(data, null, 2));

      // 检查根级别错误（DashScope API 错误通常返回在根级别）
      if (data.code || data.message) {
        throw new Error(`Bailian: ${data.message || data.code}`);
      }

      // 解析响应
      const output = data.output;
      if (!output) {
        throw new Error('Bailian未返回output');
      }

      // 检查 output 中的错误
      if (output.code || output.message) {
        throw new Error(`Bailian: ${output.message || output.code}`);
      }

      const taskId = output.task_id;
      if (!taskId) {
        // 尝试从 output 中提取更多错误信息
        const outputStr = JSON.stringify(output);
        throw new Error(`Bailian未返回task_id，output内容: ${outputStr.substring(0, 500)}`);
      }

      const taskStatus = output.task_status || 'PENDING';
      _ulogInfo(
        `${logPrefix} 任务已提交, task_id=${taskId}, status=${taskStatus}`,
      );

      return {
        success: true,
        async: true,
        requestId: taskId,
        externalId: `BAILIAN:VIDEO:${taskId}`,
      };
    } catch (error: unknown) {
      _ulogError(`${logPrefix} 生成失败:`, error);
      throw error;
    }
  }
}
