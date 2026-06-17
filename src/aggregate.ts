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

const args = process.argv.slice(2)
const hasFlag = (flag: string) => args.includes(flag)

/**
 * 从 M3U 字符串中解析频道列表
 */
const parseM3u = (m3u: string, sourceName: string): ChannelEntry[] => {
    const lines = handle_m3u(m3u)
    const entries: ChannelEntry[] = []

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
 * 对频道进行去重：同一频道 ID 保留所有不同 URL
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
            if (!existing.some((e) => e.url === entry.url)) {
                existing.push(entry)
            }
        }
    }

    return channelMap
}

/**
 * 将频道列表输出为 M3U 格式文件
 */
const writeM3uOutput = (m3uDir: string, channels: ChannelEntry[], tag: string) => {
    const m3uLines: string[] = ["#EXTM3U"]
    for (const ch of channels) {
        m3uLines.push(ch.extinf)
        m3uLines.push(ch.url)
    }
    const m3uContent = m3uLines.join("\n")

    fs.writeFileSync(path.join(m3uDir, `${tag}.m3u`), m3uContent)
    // 无扩展名副本，供 GitHub Pages 通过 /{tag} 路径访问
    fs.writeFileSync(path.join(m3uDir, tag), m3uContent)

    const txtContent = m3u2txt(m3uLines)
    const txtDir = path.join(m3uDir, "txt")
    if (!fs.existsSync(txtDir)) {
        fs.mkdirSync(txtDir, { recursive: true })
    }
    fs.writeFileSync(path.join(txtDir, `${tag}.txt`), txtContent)

    console.log(`[AGGREGATE] Written ${tag}.m3u + ${tag} + txt/${tag}.txt (${channels.length} channels)`)
}

/**
 * 聚合主逻辑
 */
export const aggregate = async () => {
    const enableCheck =
        process.env.ENABLE_STREAM_CHECK === "true" || hasFlag("--check")
    const m3uDir = path.resolve("m3u")

    if (!fs.existsSync(m3uDir)) {
        console.log("[AGGREGATE] m3u directory not found, skipping.")
        return
    }

    // 1. 读取所有 M3U 文件
    const m3uFiles = fs
        .readdirSync(m3uDir)
        .filter((f) => f.endsWith(".m3u") && f !== "aggregated.m3u" && f !== "verified.m3u")

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

    // 2. 去重
    const channelMap = deduplicateChannels(allEntries)
    const uniqueChannelIds = channelMap.size
    const totalUrls = Array.from(channelMap.values()).reduce(
        (sum, entries) => sum + entries.length,
        0
    )

    console.log(
        `[AGGREGATE] Unique channels: ${uniqueChannelIds}, Total unique URLs: ${totalUrls}`
    )

    // 3. 流可用性检测
    let finalChannels: ChannelEntry[]

    if (enableCheck) {
        console.log("[AGGREGATE] Stream checking ENABLED (--check), verifying from local network...")
        const startTime = hrtime.bigint()

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

        const results = await checkStreamsBatch(
            allStreams,
            undefined,
            (checked, total) => {
                if (checked % 100 === 0 || checked === total) {
                    console.log(`[AGGREGATE] Progress: ${checked}/${total}`)
                }
            }
        )

        for (let i = 0; i < results.length; i++) {
            const mapping = streamIndexMap.get(i)!
            const entry = channelMap.get(mapping.channelId)![mapping.entryIdx]
            entry.latency = results[i].latency
            if (!results[i].available) {
                entry.url = ""
            }
        }

        const elapsed =
            (parseInt(hrtime.bigint().toString()) - parseInt(startTime.toString())) / 1e6
        console.log(`[AGGREGATE] Stream check completed in ${elapsed.toFixed(0)}ms`)

        // 每个频道选延迟最低
        finalChannels = []
        for (const [, entries] of channelMap) {
            const available = entries.filter((e) => e.url !== "")
            if (available.length > 0) {
                available.sort((a, b) => a.latency - b.latency)
                finalChannels.push(available[0])
            }
        }

        const removedCount = totalUrls - finalChannels.length
        console.log(
            `[AGGREGATE] After filtering: ${finalChannels.length} available, removed ${removedCount} unavailable`
        )

        // 本地验证版输出到 verified.m3u
        writeM3uOutput(m3uDir, finalChannels, "verified")
    } else {
        console.log(
            "[AGGREGATE] Stream checking DISABLED (use --check or ENABLE_STREAM_CHECK=true to enable)"
        )
        finalChannels = []
        for (const [, entries] of channelMap) {
            finalChannels.push(entries[0])
        }
    }

    // 4. 始终输出 aggregated（不去重检测的全量版）
    writeM3uOutput(m3uDir, finalChannels, "aggregated")

    console.log(
        `[AGGREGATE] Done! ${finalChannels.length} channels.`
    )
}

// 独立运行
if (process.argv[1]?.endsWith("aggregate.js") || process.argv[1]?.endsWith("aggregate.ts")) {
    aggregate().catch(console.error)
}
