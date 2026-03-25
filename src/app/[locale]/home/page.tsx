'use client'

/**
 * 首页 - 创作中心
 * 用户登录后的主入口页面：快速创作 + 最近项目
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useTranslations } from 'next-intl'
import Navbar from '@/components/Navbar'
import { AppIcon, IconGradientDefs } from '@/components/ui/icons'
import { RatioSelector, StyleSelector } from '@/components/selectors/RatioStyleSelectors'
import { ART_STYLES, VIDEO_RATIOS } from '@/lib/constants'
import { Link, useRouter } from '@/i18n/navigation'
import { apiFetch } from '@/lib/api-fetch'
import { createHomeProjectLaunch } from '@/lib/home/create-project-launch'
import {
  HOME_QUICK_START_MIN_ROWS,
  resolveTextareaTargetHeight,
} from '@/lib/home/quick-start-textarea'

interface ProjectStats {
  episodes: number
  images: number
  videos: number
  panels: number
  firstEpisodePreview: string | null
}

interface Project {
  id: string
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
  stats?: ProjectStats
}

const RECENT_COUNT = 5

export default function HomePage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const t = useTranslations('home')
  const tc = useTranslations('common')

  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [inputValue, setInputValue] = useState('')
  const [videoRatio, setVideoRatio] = useState('9:16')
  const [artStyle, setArtStyle] = useState('american-comic')
  const [createLoading, setCreateLoading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const textareaMinHeightRef = useRef<number | null>(null)

  // textarea 自适应高度（rAF 分帧动画）
  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const maxH = window.innerHeight * 0.5
    const oldH = el.offsetHeight
    const oldScrollTop = el.scrollTop
    if (textareaMinHeightRef.current === null && oldH > 0) {
      textareaMinHeightRef.current = oldH
    }
    const minH = textareaMinHeightRef.current ?? oldH

    // 同步：测量真实高度（不改 overflow，避免 scrollTop 被重置）
    el.style.transition = 'none'
    el.style.height = 'auto'
    const scrollH = el.scrollHeight
    const targetH = resolveTextareaTargetHeight({
      minHeight: minH,
      maxHeight: maxH,
      scrollHeight: scrollH,
    })
    el.style.height = `${oldH}px`
    el.scrollTop = oldScrollTop

    // 下一帧：开启 transition → 动画到目标高度
    requestAnimationFrame(() => {
      el.scrollTop = oldScrollTop
      el.style.transition = 'height 200ms ease-out'
      el.style.height = `${targetH}px`
      el.style.overflowY = scrollH > maxH ? 'auto' : 'hidden'
    })
  }, [])

  useEffect(() => {
    autoResizeTextarea()
  }, [inputValue, autoResizeTextarea])

  // 鉴权
  useEffect(() => {
    if (status === 'loading') return
    if (!session) {
      router.push({ pathname: '/auth/signin' })
    }
  }, [session, status, router])

  // 获取最近项目
  const fetchRecentProjects = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams({
        page: '1',
        pageSize: RECENT_COUNT.toString(),
      })
      const response = await apiFetch(`/api/projects?${params}`)
      if (response.ok) {
        const data = await response.json()
        setProjects(data.projects)
      }
    } catch {
      // 静默处理
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (session) {
      void fetchRecentProjects()
    }
  }, [session, fetchRecentProjects])

  // 创建项目并跳转
  const handleCreate = async () => {
    if (!inputValue.trim() || createLoading) return
    setCreateLoading(true)
    try {
      const storyText = inputValue.trim()
      const result = await createHomeProjectLaunch({
        apiFetch,
        projectName: storyText.slice(0, 50),
        storyText,
        videoRatio,
        artStyle,
        episodeName: `${tc('episode')} 1`,
      })

      router.push(result.target)
    } catch (error) {
      const message = error instanceof Error ? error.message : t('createFailed')
      window.alert(message)
    } finally {
      setCreateLoading(false)
    }
  }

  // 比例选项（带推荐标签）
  const ratioOptions = useMemo(
    () => VIDEO_RATIOS.map((r) => ({ ...r, recommended: r.value === '9:16' })),
    []
  )

  // 风格选项（带推荐标签）
  const styleOptions = useMemo(
    () => ART_STYLES.map((s) => ({ ...s, recommended: s.value === 'realistic' })),
    []
  )

  // 时间格式化
  const formatTimeAgo = (dateString: string): string => {
    const diffMs = Date.now() - new Date(dateString).getTime()
    const diffMinutes = Math.floor(diffMs / (1000 * 60))
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    if (diffMinutes < 1) return t('ago.justNow')
    if (diffMinutes < 60) return t('ago.minutesAgo', { n: diffMinutes })
    if (diffHours < 24) return t('ago.hoursAgo', { n: diffHours })
    return t('ago.daysAgo', { n: diffDays })
  }

  if (status === 'loading' || !session) {
    return (
      <div className="glass-page min-h-screen flex items-center justify-center">
        <div className="text-[var(--glass-text-secondary)]">{tc('loading')}</div>
      </div>
    )
  }

  return (
    <div className="glass-page min-h-screen">
      <Navbar />

      {/* 自定义呼吸动画 */}
      <style>{`
        @keyframes breathe-drift-1 {
          0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.5; }
          25% { transform: translate(30px, -20px) scale(1.15); opacity: 0.7; }
          50% { transform: translate(-20px, 15px) scale(0.95); opacity: 0.4; }
          75% { transform: translate(15px, 25px) scale(1.1); opacity: 0.65; }
        }
        @keyframes breathe-drift-2 {
          0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.45; }
          30% { transform: translate(-25px, 20px) scale(1.2); opacity: 0.7; }
          60% { transform: translate(20px, -15px) scale(0.9); opacity: 0.35; }
          80% { transform: translate(-10px, -25px) scale(1.05); opacity: 0.6; }
        }
        @keyframes breathe-drift-3 {
          0%, 100% { transform: translate(0, 0) scale(1.05); opacity: 0.4; }
          20% { transform: translate(20px, 15px) scale(0.9); opacity: 0.55; }
          45% { transform: translate(-15px, -20px) scale(1.15); opacity: 0.7; }
          70% { transform: translate(10px, -10px) scale(1); opacity: 0.35; }
        }
      `}</style>

      <main className="flex flex-col items-center pt-[16vh] pb-12 px-4 max-w-3xl mx-auto w-full">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-bold text-[var(--glass-text-primary)] mb-2">
            ✨ {t('title')}
          </h1>
          <p className="text-sm text-[var(--glass-text-tertiary)]">{t('subtitle')}</p>
        </div>

        {/* 呼吸光晕 + 输入区域 */}
        <div className="w-full relative group">
          <div
            className="absolute -inset-10 rounded-[48px] pointer-events-none"
            style={{
              background: 'radial-gradient(ellipse 80% 60% at 30% 40%, rgba(6, 182, 212, 0.4), transparent 70%)',
              animation: 'breathe-drift-1 8s ease-in-out infinite',
              filter: 'blur(30px)',
            }}
          />
          <div
            className="absolute -inset-10 rounded-[48px] pointer-events-none"
            style={{
              background: 'radial-gradient(ellipse 70% 80% at 70% 60%, rgba(139, 92, 246, 0.35), transparent 70%)',
              animation: 'breathe-drift-2 10s ease-in-out infinite',
              filter: 'blur(35px)',
            }}
          />
          <div
            className="absolute -inset-12 rounded-[56px] pointer-events-none"
            style={{
              background: 'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(59, 130, 246, 0.3), transparent 70%)',
              animation: 'breathe-drift-3 12s ease-in-out infinite',
              filter: 'blur(40px)',
            }}
          />

          <div className="relative w-full glass-surface-elevated rounded-2xl">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={t('inputPlaceholder')}
              rows={HOME_QUICK_START_MIN_ROWS}
              className="w-full bg-transparent border-none outline-none text-[var(--glass-text-primary)] placeholder:text-[var(--glass-text-tertiary)] text-base resize-none p-5 pb-3 custom-scrollbar"
            />

            {/* 底部工具栏：比例 + 风格 + 创建按钮 */}
            <div className="flex items-end gap-3 px-5 pb-4">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-[160px] flex-shrink-0">
                  <RatioSelector
                    value={videoRatio}
                    onChange={setVideoRatio}
                    options={ratioOptions}
                  />
                </div>
                <div className="w-[160px] flex-shrink-0">
                  <StyleSelector
                    value={artStyle}
                    onChange={setArtStyle}
                    options={styleOptions}
                  />
                </div>
              </div>
              <button
                onClick={() => void handleCreate()}
                disabled={!inputValue.trim() || createLoading}
                className="glass-btn-base glass-btn-primary px-5 py-2.5 text-sm flex-shrink-0 disabled:opacity-50"
              >
                {createLoading ? tc('loading') : t('startCreation')}
                <AppIcon name="arrowRight" className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </main>

      {/* 最近项目 */}
      <section className="px-4 sm:px-6 lg:px-10 pb-8 max-w-[1400px] mx-auto w-full">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-[var(--glass-text-secondary)]">{t('recentProjects')}</h2>
          <Link
            href={{ pathname: '/workspace' }}
            className="text-xs text-[var(--glass-tone-info-fg)] hover:underline font-medium"
          >
            {t('viewAll')}
          </Link>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="glass-surface p-5 animate-pulse">
                <div className="h-4 bg-[var(--glass-bg-muted)] rounded mb-3" />
                <div className="h-3 bg-[var(--glass-bg-muted)] rounded mb-2" />
                <div className="h-3 bg-[var(--glass-bg-muted)] rounded w-2/3" />
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-12">
            <div className="w-12 h-12 bg-[var(--glass-bg-muted)] rounded-xl flex items-center justify-center mx-auto mb-3">
              <AppIcon name="folderCards" className="w-6 h-6 text-[var(--glass-text-tertiary)]" />
            </div>
            <p className="text-sm text-[var(--glass-text-tertiary)]">{t('noProjects')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={{ pathname: `/workspace/${project.id}` }}
                className="glass-surface cursor-pointer group hover:border-[var(--glass-tone-info-fg)]/40 transition-all duration-300 overflow-hidden relative block"
              >
                <div className="absolute inset-0 rounded-[inherit] bg-gradient-to-br from-blue-500/5 to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                <div className="p-5 relative z-10">
                  <h3 className="text-sm font-bold text-[var(--glass-text-primary)] mb-2 group-hover:text-[var(--glass-tone-info-fg)] transition-colors line-clamp-1">
                    {project.name}
                  </h3>
                  {(project.description || project.stats?.firstEpisodePreview) && (
                    <div className="flex items-start gap-2 mb-3">
                      <AppIcon name="fileText" className="w-3.5 h-3.5 text-[var(--glass-text-tertiary)] mt-0.5 flex-shrink-0" />
                      <p className="text-xs text-[var(--glass-text-secondary)] line-clamp-2 leading-relaxed">
                        {project.description || project.stats?.firstEpisodePreview}
                      </p>
                    </div>
                  )}
                  {project.stats && (project.stats.episodes > 0 || project.stats.images > 0 || project.stats.videos > 0) && (
                    <div className="flex items-center gap-2 mb-3">
                      <IconGradientDefs className="w-0 h-0 absolute" aria-hidden="true" />
                      <AppIcon name="statsBarGradient" className="w-4 h-4 flex-shrink-0" />
                      <div className="flex items-center gap-3 text-sm font-semibold bg-gradient-to-r from-blue-500 to-cyan-500 bg-clip-text text-transparent">
                        {project.stats.episodes > 0 && (
                          <span className="flex items-center gap-1">
                            <AppIcon name="statsEpisodeGradient" className="w-3.5 h-3.5" />
                            {project.stats.episodes}
                          </span>
                        )}
                        {project.stats.images > 0 && (
                          <span className="flex items-center gap-1">
                            <AppIcon name="statsImageGradient" className="w-3.5 h-3.5" />
                            {project.stats.images}
                          </span>
                        )}
                        {project.stats.videos > 0 && (
                          <span className="flex items-center gap-1">
                            <AppIcon name="statsVideoGradient" className="w-3.5 h-3.5" />
                            {project.stats.videos}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-1 text-[10px] text-[var(--glass-text-tertiary)]">
                    <AppIcon name="clock" className="w-3 h-3" />
                    {formatTimeAgo(project.updatedAt)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
