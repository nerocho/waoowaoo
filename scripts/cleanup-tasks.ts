/**
 * 清理脚本：清理数据库和 Redis 中的积压任务
 *
 * 用法：npx tsx scripts/cleanup-tasks.ts [--status=failed,queued,processing] [--days=7] [--dry-run]
 *
 * 选项：
 * --status    要清理的任务状态（默认：failed）
 * --days      清理多少天前的任务（默认：7）
 * --dry-run   只显示将要清理的任务数量，不实际删除
 * --clear-redis-queues  清空 Redis 队列
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { Queue } from 'bullmq'
import { queueRedis } from '@/lib/redis'
import { createScopedLogger } from '@/lib/logging/core'

const logger = createScopedLogger({
  module: 'scripts.cleanup-tasks',
  action: 'cleanup',
})

const QUEUE_NAMES = ['waoowaoo-image', 'waoowaoo-video', 'waoowaoo-voice', 'waoowaoo-text'] as const

interface CleanupOptions {
  status: string[]
  days: number
  dryRun: boolean
  clearRedisQueues: boolean
}

function parseArgs(): CleanupOptions {
  const args = process.argv.slice(2)
  const options: CleanupOptions = {
    status: ['failed'],
    days: 7,
    dryRun: false,
    clearRedisQueues: false,
  }

  for (const arg of args) {
    if (arg.startsWith('--status=')) {
      options.status = arg.split('=')[1].split(',')
    } else if (arg.startsWith('--days=')) {
      options.days = parseInt(arg.split('=')[1], 10)
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--clear-redis-queues') {
      options.clearRedisQueues = true
    }
  }

  return options
}

async function getQueueStats() {
  const stats: Record<string, { waiting: number; active: number; delayed: number; failed: number; completed: number }> = {}

  for (const queueName of QUEUE_NAMES) {
    const queue = new Queue(queueName, { connection: queueRedis })
    const [waiting, active, delayed, failed, completed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getDelayedCount(),
      queue.getFailedCount(),
      queue.getCompletedCount(),
    ])
    stats[queueName] = { waiting, active, delayed, failed, completed }
    await queue.close()
  }

  return stats
}

async function clearRedisQueues(dryRun: boolean) {
  console.log('\n📊 Redis 队列状态:')
  const stats = await getQueueStats()

  for (const [queueName, counts] of Object.entries(stats)) {
    const total = counts.waiting + counts.active + counts.delayed + counts.failed + counts.completed
    console.log(`  ${queueName}:`)
    console.log(`    - 等待中: ${counts.waiting}`)
    console.log(`    - 处理中: ${counts.active}`)
    console.log(`    - 延迟中: ${counts.delayed}`)
    console.log(`    - 失败: ${counts.failed}`)
    console.log(`    - 完成: ${counts.completed}`)
    console.log(`    - 总计: ${total}`)
  }

  if (dryRun) {
    console.log('\n🔍 [DRY-RUN] 将清空所有 Redis 队列')
    return
  }

  console.log('\n🧹 清空 Redis 队列...')

  for (const queueName of QUEUE_NAMES) {
    const queue = new Queue(queueName, { connection: queueRedis })

    // 清空所有类型的工作
    await queue.drain() // 清空等待中的任务
    await queue.clean(0, 10000, 'failed') // 清理失败任务
    await queue.clean(0, 10000, 'completed') // 清理完成任务

    console.log(`  ✓ ${queueName} 已清空`)
    await queue.close()
  }

  console.log('✅ Redis 队列已清空')
}

async function cleanupDatabaseTasks(options: CleanupOptions) {
  const { status, days, dryRun } = options
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  console.log(`\n📊 数据库任务统计 (${days} 天前):`)

  // 统计各状态的任务数量
  const statusCounts = await prisma.task.groupBy({
    by: ['status'],
    where: {
      createdAt: { lt: cutoffDate },
    },
    _count: true,
  })

  for (const { status: s, _count } of statusCounts) {
    console.log(`  ${s}: ${_count}`)
  }

  // 统计将要清理的任务
  const toDelete = await prisma.task.count({
    where: {
      status: { in: status },
      createdAt: { lt: cutoffDate },
    },
  })

  console.log(`\n🎯 将要清理的任务 (${status.join(', ')}): ${toDelete}`)

  if (dryRun) {
    console.log('\n🔍 [DRY-RUN] 不实际删除任务')
    return
  }

  if (toDelete === 0) {
    console.log('\n✅ 没有需要清理的任务')
    return
  }

  console.log('\n🧹 清理数据库任务...')

  // 直接删除，deleteMany 不支持 take 参数
  const result = await prisma.task.deleteMany({
    where: {
      status: { in: status },
      createdAt: { lt: cutoffDate },
    },
  })

  console.log(`\n✅ 数据库清理完成，共删除 ${result.count} 条任务记录`)
}

async function cleanupActiveTasksWithoutJobs(dryRun: boolean) {
  console.log('\n📊 检查孤儿任务（数据库显示活跃但 Redis 队列中不存在）...')

  // 获取所有活跃任务
  const activeTasks = await prisma.task.findMany({
    where: {
      status: { in: ['queued', 'processing'] },
    },
    select: { id: true, status: true, createdAt: true },
    take: 1000,
  })

  console.log(`  活跃任务总数: ${activeTasks.length}`)

  // 检查每个任务是否在 Redis 队列中
  const orphanTasks: string[] = []

  for (const task of activeTasks) {
    let found = false
    for (const queueName of QUEUE_NAMES) {
      const queue = new Queue(queueName, { connection: queueRedis })
      const job = await queue.getJob(task.id)
      await queue.close()
      if (job) {
        found = true
        break
      }
    }

    if (!found) {
      orphanTasks.push(task.id)
    }
  }

  console.log(`  孤儿任务数: ${orphanTasks.length}`)

  if (orphanTasks.length === 0) {
    console.log('\n✅ 没有孤儿任务')
    return
  }

  if (dryRun) {
    console.log(`\n🔍 [DRY-RUN] 将标记 ${orphanTasks.length} 个孤儿任务为失败`)
    return
  }

  // 标记孤儿任务为失败
  const result = await prisma.task.updateMany({
    where: {
      id: { in: orphanTasks },
    },
    data: {
      status: 'failed',
      errorCode: 'ORPHAN_CLEANUP',
      errorMessage: 'Task was orphaned (no matching job in Redis queue)',
      finishedAt: new Date(),
      heartbeatAt: null,
    },
  })

  console.log(`\n✅ 已标记 ${result.count} 个孤儿任务为失败`)
}

async function main() {
  const options = parseArgs()

  console.log('========================================')
  console.log('任务清理脚本')
  console.log('========================================')
  console.log(`模式: ${options.dryRun ? 'DRY-RUN (仅预览)' : '实际执行'}`)
  console.log(`清理状态: ${options.status.join(', ')}`)
  console.log(`时间范围: ${options.days} 天前`)
  console.log(`清空 Redis 队列: ${options.clearRedisQueues ? '是' : '否'}`)
  console.log('========================================')

  try {
    // 1. 显示当前状态
    await getQueueStats()

    // 2. 清理 Redis 队列
    if (options.clearRedisQueues) {
      await clearRedisQueues(options.dryRun)
    }

    // 3. 清理数据库任务
    await cleanupDatabaseTasks(options)

    // 4. 检查并清理孤儿任务
    await cleanupActiveTasksWithoutJobs(options.dryRun)

    console.log('\n========================================')
    console.log('清理完成')
    console.log('========================================')

  } catch (error) {
    console.error('\n❌ 清理过程中出错:', error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error('\n❌ 清理失败:', error)
  process.exit(1)
})