'use client'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRefreshProjectAssets, useProjectAssets, useProjectData } from '@/lib/query/hooks'
import TaskStatusInline from '@/components/task/TaskStatusInline'
import { resolveTaskPresentationState } from '@/lib/task/presentation'
import { AppIcon } from '@/components/ui/icons'
import JSZip from 'jszip'
import { logError as _logError } from '@/lib/logging/core'

/**
 * AssetToolbar - 资产管理工具栏组件
 * 从 AssetsStage.tsx 提取，负责批量操作和刷新按钮
 */

interface AssetToolbarProps {
    projectId: string
    totalAssets: number
    totalAppearances: number
    totalLocations: number
    isBatchSubmitting: boolean
    isAnalyzingAssets: boolean
    isGlobalAnalyzing?: boolean
    batchProgress: { current: number; total: number }
    onGenerateAll: () => void
    onRegenerateAll: () => void
    onGlobalAnalyze?: () => void
}

export default function AssetToolbar({
    projectId,
    totalAssets,
    totalAppearances,
    totalLocations,
    isBatchSubmitting,
    isAnalyzingAssets,
    isGlobalAnalyzing = false,
    batchProgress,
    onGenerateAll,
    onRegenerateAll,
    onGlobalAnalyze
}: AssetToolbarProps) {
    const onRefresh = useRefreshProjectAssets(projectId)
    const t = useTranslations('assets')
    const { data: assets } = useProjectAssets(projectId)
    const { data: projectData } = useProjectData(projectId)
    const projectName = projectData?.name
    const [isDownloading, setIsDownloading] = useState(false)

    const assetTaskRunningState = isBatchSubmitting
        ? resolveTaskPresentationState({
            phase: 'processing',
            intent: 'generate',
            resource: 'image',
            hasOutput: true,
        })
        : null

    const handleDownloadAll = async () => {
        const characters = assets?.characters ?? []
        const locations = assets?.locations ?? []

        const imageEntries: Array<{ filename: string; url: string }> = []

        // 角色图片
        for (const character of characters) {
            for (const appearance of character.appearances ?? []) {
                const url = appearance.imageUrl
                if (!url) continue
                const safeName = character.name.replace(/[/\\:*?"<>|]/g, '_')
                const filename = appearance.appearanceIndex === 0
                    ? `characters/${safeName}.jpg`
                    : `characters/${safeName}_appearance${appearance.appearanceIndex}.jpg`
                imageEntries.push({ filename, url })
            }
        }

        // 场景图片：取已选中的那张（或第一张）
        for (const location of locations) {
            const selectedImage = location.images?.find((img: { isSelected: boolean; imageUrl: string | null }) => img.isSelected) ?? location.images?.[0]
            const url = selectedImage?.imageUrl
            if (!url) continue
            const safeName = location.name.replace(/[/\\:*?"<>|]/g, '_')
            imageEntries.push({ filename: `locations/${safeName}.jpg`, url })
        }

        if (imageEntries.length === 0) {
            alert(t('assetLibrary.downloadEmpty'))
            return
        }

        setIsDownloading(true)
        try {
            const zip = new JSZip()
            await Promise.all(
                imageEntries.map(async ({ filename, url }) => {
                    try {
                        const response = await fetch(url)
                        if (!response.ok) return
                        const blob = await response.blob()
                        zip.file(filename, blob)
                    } catch {
                        // 单张失败不阻断其他
                    }
                })
            )
            const content = await zip.generateAsync({ type: 'blob' })
            const link = document.createElement('a')
            link.href = URL.createObjectURL(content)
            const safeName = projectName ? projectName.replace(/[/\\:*?"<>|]/g, '_') : 'assets'
            link.download = `${safeName}_${new Date().toISOString().slice(0, 10)}.zip`
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
            URL.revokeObjectURL(link.href)
        } catch (error) {
            _logError('打包下载失败:', error)
            alert(t('assetLibrary.downloadFailed'))
        } finally {
            setIsDownloading(false)
        }
    }

    return (
        <div className="glass-surface p-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <span className="text-sm font-semibold text-[var(--glass-text-secondary)] inline-flex items-center gap-2">
                        <AppIcon name="diamond" className="w-4 h-4 text-[var(--glass-tone-info-fg)]" />
                        {t("toolbar.assetManagement")}
                    </span>
                    <span className="text-sm text-[var(--glass-text-tertiary)]">
                        {t("toolbar.assetCount", { total: totalAssets, appearances: totalAppearances, locations: totalLocations })}
                    </span>
                    {/* 全局资产分析按钮 */}
                    {onGlobalAnalyze && (
                        <button
                            onClick={onGlobalAnalyze}
                            disabled={isGlobalAnalyzing || isBatchSubmitting || isAnalyzingAssets}
                            className="glass-btn-base glass-btn-primary flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            title={t("toolbar.globalAnalyzeHint")}
                        >
                            <AppIcon name="idea" className="w-3.5 h-3.5" />
                            <span>{t("toolbar.globalAnalyze")}</span>
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={onGenerateAll}
                        disabled={isBatchSubmitting || isAnalyzingAssets || isGlobalAnalyzing}
                        className="glass-btn-base glass-btn-tone-success flex items-center gap-2 px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isBatchSubmitting ? (
                            <>
                                <TaskStatusInline state={assetTaskRunningState} className="text-white [&>span]:text-white [&_svg]:text-white" />
                                <span className="text-xs text-white/90">({batchProgress.current}/{batchProgress.total})</span>
                            </>
                        ) : (
                            <>
                                <AppIcon name="image" className="w-4 h-4" />
                                <span>{t("toolbar.generateAll")}</span>
                            </>
                        )}
                    </button>
                    <button
                        onClick={onRegenerateAll}
                        disabled={isBatchSubmitting || isAnalyzingAssets || isGlobalAnalyzing}
                        className="glass-btn-base glass-btn-tone-warning flex items-center gap-2 px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        title={t("toolbar.regenerateAllHint")}
                    >
                        <AppIcon name="refresh" className="w-4 h-4" />
                        <span>{t("toolbar.regenerateAll")}</span>
                    </button>
                    <button
                        onClick={() => onRefresh()}
                        className="glass-btn-base glass-btn-secondary flex items-center gap-2 px-4 py-2 text-sm font-medium border border-[var(--glass-stroke-base)]"
                    >
                        <AppIcon name="refresh" className="w-4 h-4" />
                        <span>{t("common.refresh")}</span>
                    </button>
                    {/* 打包下载按钮 */}
                    <button
                        onClick={handleDownloadAll}
                        disabled={isDownloading || totalAssets === 0}
                        title={t("toolbar.downloadAll")}
                        className="glass-btn-base glass-btn-secondary flex items-center justify-center w-9 h-9 disabled:opacity-50 disabled:cursor-not-allowed border border-[var(--glass-stroke-base)]"
                    >
                        <AppIcon
                            name={isDownloading ? 'refresh' : 'download'}
                            className={`w-4 h-4 ${isDownloading ? 'animate-spin' : ''}`}
                        />
                    </button>
                </div>
            </div>
        </div>
    )
}
