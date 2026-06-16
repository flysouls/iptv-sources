import "dotenv/config"
import fs from "fs"
import path from "path"
import { hrtime } from "process"

import { get_channel_id } from "./utils/id"
import { handle_m3u } from "./sources/utils"
import { m3u2txt } from "./utils/m3u2txt"
import { checkStreamsBatch, type StreamInfo } from "./checker/stream"

interface ChannelEntry {
    extinf: string
    url: string
    source: string
    latency: number
}

/**
 * 从 M3U 字符串中解析频道列表
 */
const parseM3u = (m3u: string, sourceName: string): ChannelEntry[] => {
    const lines = handle_m3u(m3u)
    const entries: ChannelEntry[] = []

    // handle_m3u 返回格式: [header, extinf1, url1, extinf2, url2, ...]
    for (let i = 1; i < lines.length; i += 2) {
        const extinf = lines[i]
        const url = lines[i + 1]
        if (extinf && url) {
            entries.push({ extinf, url, source: sourceName, latency: -1 })
        }
    }

    return entries
}

/**
 * 对频道进行去重：同一频道 ID 保留所有不同 URL，后续用于可用性检测
 */
const deduplicateChannels = (
    entries: ChannelEntry[]
): Map<string, ChannelEntry[]> => {
    const channelMap = new Map<string, ChannelEntry[]>()

    for (const entry of entries) {
        const id = get_channel_id(entry.extinf)
        if (!id) continue

        if (!channelMap.has(id)) {
            channelMap.set(id, [entry])
        } else {
            const existing = channelMap.get(id)!
            // 避免同一 URL 重复
            if (!existing.some((e) => e.url === entry.url)) {
                existing.push(entry)
            }
        }
    }

    return channelMap
}

/**
 * 聚合主逻辑
 */
export const aggregate = async () => {
    const enableCheck = process.env.ENABLE_STREAM_CHECK === "true"
    const m3uDir = path.resolve("m3u")

    if (!fs.existsSync(m3uDir)) {
        console.log("[AGGREGATE] m3u directory not found, skipping.")
        return
    }

    // 1. 读取所有 M3U 文件
    const m3uFiles = fs
        .readdirSync(m3uDir)
        .filter((f) => f.endsWith(".m3u") && f !== "aggregated.m3u")

    console.log(`[AGGREGATE] Found ${m3uFiles.length} M3U files to process`)

    const allEntries: ChannelEntry[] = []

    for (const file of m3uFiles) {
        const filePath = path.join(m3uDir, file)
        const content = fs.readFileSync(filePath, "utf-8")
        const entries = parseM3u(content, file.replace(".m3u", ""))
        allEntries.push(...entries)
        console.log(`[AGGREGATE] Parsed ${file}: ${entries.length} channels`)
    }

    console.log(
        `[AGGREGATE] Total raw entries (across all sources): ${allEntries.length}`
    )

    // 2. 去重：按频道 ID 分组，保留所有不同 URL
    const channelMap = deduplicateChannels(allEntries)
    const uniqueChannelIds = channelMap.size
    const totalUrls = Array.from(channelMap.values()).reduce(
        (sum, entries) => sum + entries.length,
        0
    )

    console.log(
        `[AGGREGATE] Unique channels: ${uniqueChannelIds}, Total unique URLs: ${totalUrls}`
    )

    // 3. 可选：流可用性检测
    let finalChannels: ChannelEntry[]

    if (enableCheck) {
        console.log("[AGGREGATE] Stream checking ENABLED, starting verification...")
        const startTime = hrtime.bigint()

        // 收集所有需要检测的流
        const allStreams: StreamInfo[] = []
        const streamIndexMap = new Map<number, { channelId: string; entryIdx: number }>()

        let streamIdx = 0
        for (const [channelId, entries] of channelMap) {
            for (let ei = 0; ei < entries.length; ei++) {
                streamIndexMap.set(streamIdx, { channelId, entryIdx: ei })
                allStreams.push({
                    extinf: entries[ei].extinf,
                    url: entries[ei].url,
                })
                streamIdx++
            }
        }

        // 批量检测
        const results = await checkStreamsBatch(
            allStreams,
            undefined,
            (checked, total) => {
                if (checked % 100 === 0 || checked === total) {
                    console.log(`[AGGREGATE] Progress: ${checked}/${total}`)
                }
            }
        )

        // 更新 latency 信息
        for (let i = 0; i < results.length; i++) {
            const mapping = streamIndexMap.get(i)!
            const entry = channelMap.get(mapping.channelId)![mapping.entryIdx]
            entry.latency = results[i].latency

            if (!results[i].available) {
                // 标记为不可用
                entry.url = ""
            }
        }

        const elapsed =
            (parseInt(hrtime.bigint().toString()) - parseInt(startTime.toString())) / 1e6
        console.log(`[AGGREGATE] Stream check completed in ${elapsed.toFixed(0)}ms`)

        // 为每个频道选择最佳可用流（延迟最低的）
        finalChannels = []
        for (const [channelId, entries] of channelMap) {
            const available = entries.filter((e) => e.url !== "")
            if (available.length > 0) {
                // 按延迟排序，选最快的
                available.sort((a, b) => a.latency - b.latency)
                finalChannels.push(available[0])
            }
        }

        const removedCount = totalUrls - finalChannels.length
        console.log(
            `[AGGREGATE] After filtering: ${finalChannels.length} available channels, removed ${removedCount} unavailable streams`
        )
    } else {
        console.log(
            "[AGGREGATE] Stream checking DISABLED (set ENABLE_STREAM_CHECK=true to enable)"
        )
        // 不检测时，每个频道取第一个 URL
        finalChannels = []
        for (const [, entries] of channelMap) {
            finalChannels.push(entries[0])
        }
    }

    // 4. 输出聚合后的 M3U 文件
    const m3uLines: string[] = ["#EXTM3U"]
    for (const ch of finalChannels) {
        m3uLines.push(ch.extinf)
        m3uLines.push(ch.url)
    }
    const m3uContent = m3uLines.join("\n")

    fs.writeFileSync(path.join(m3uDir, "aggregated.m3u"), m3uContent)
    console.log(`[AGGREGATE] Written m3u/aggregated.m3u (${finalChannels.length} channels)`)

    // 5. 输出 TXT 格式
    const txtContent = m3u2txt(m3uLines)
    const txtDir = path.join(m3uDir, "txt")
    if (!fs.existsSync(txtDir)) {
        fs.mkdirSync(txtDir, { recursive: true })
    }
    fs.writeFileSync(path.join(txtDir, "aggregated.txt"), txtContent)
    console.log(`[AGGREGATE] Written m3u/txt/aggregated.txt`)

    console.log(
        `[AGGREGATE] Done! ${finalChannels.length} channels aggregated successfully.`
    )
}

// 支持独立运行
if (process.argv[1]?.endsWith("aggregate.js") || process.argv[1]?.endsWith("aggregate.ts")) {
    aggregate().catch(console.error)
}
